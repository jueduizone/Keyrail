import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSecretBackend, redactSecrets } from "@keyrail/backends";
import {
  KeyrailError,
  MANIFEST_FILE,
  getContext,
  identifyProject,
  loadManifest,
  resolveActiveContextName,
  writeContextLock,
  verifyIdentity,
  writeManifest
} from "@keyrail/core";
import { evaluatePolicy, normalizeCommand } from "@keyrail/policy";

export async function main(argv) {
  const { command, args, flags, passthrough } = parseArgs(argv);

  switch (command) {
    case "init":
      return initCommand(flags);
    case "bind":
      return bindCommand(flags);
    case "current":
      return currentCommand(flags);
    case "identify":
      return identifyCommand(flags);
    case "doctor":
      return doctorCommand(flags);
    case "run":
      return runCommand(args, flags, passthrough);
    case "handoff":
      return handoffCommand(flags);
    case "secrets":
      return secretsCommand(args, flags);
    case "ui":
    case "serve":
      return serveCommand(flags);
    case "help":
    case undefined:
      return printHelp();
    default:
      throw new KeyrailError("UNKNOWN_COMMAND", `Unknown command "${command}"`);
  }
}

async function initCommand(flags) {
  const root = process.cwd();
  const repo = flags.repo ?? "local";
  const id = flags.id ?? path.basename(root);
  const name = flags.name ?? titleize(id);
  const defaultContext = flags.context ?? "local";
  const manifest = {
    project: { id, name, repo, defaultContext },
    contexts: {
      [defaultContext]: {
        name: defaultContext,
        risk: "low",
        secrets: {},
        requireConfirmation: false
      }
    },
    policy: {
      allow: ["gh issue list", "vercel deploy", "supabase db push"],
      requireConfirm: ["vercel deploy --prod", "supabase db reset"],
      deny: ["gh repo delete"]
    }
  };

  const manifestPath = await writeManifest(root, manifest);
  await writeContextLock(root, { project: id, context: defaultContext });
  console.log(`Created ${manifestPath}`);
}

async function bindCommand(flags) {
  const loaded = await loadManifest(process.cwd());
  const identity = await identifyProject(loaded.root, loaded.manifest);
  verifyIdentity(identity, loaded.manifest);
  const contextName = flags.context ?? loaded.manifest.project.defaultContext;
  getContext(loaded.manifest, contextName);
  await writeContextLock(loaded.root, { project: loaded.manifest.project.id, context: contextName });
  console.log(`Bound ${loaded.manifest.project.id} to ${contextName}`);
}

async function currentCommand(flags) {
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  const payload = {
    project: state.manifest.project,
    context: state.context,
    identity: state.identity,
    secrets
  };

  if (flags.json) return printJson(payload);
  console.log(`${state.manifest.project.name} (${state.manifest.project.id})`);
  console.log(`Root: ${state.root}`);
  console.log(`Context: ${state.context.name} (${state.context.risk})`);
  console.log(`Identity: ${state.verification.reason}`);
  printSecretReferences(secrets);
}

async function identifyCommand(flags) {
  let loaded = null;
  try {
    loaded = await loadManifest(process.cwd());
  } catch (error) {
    if (error.code !== "MANIFEST_NOT_FOUND") throw error;
  }

  const root = loaded?.root ?? process.cwd();
  const identity = await identifyProject(root, loaded?.manifest ?? null);
  if (flags.json) return printJson(identity);
  console.log(`Root: ${identity.root}`);
  console.log(`Git remote: ${identity.gitRemote ?? "none"}`);
  console.log(`Package: ${identity.packageName ?? "none"}`);
  if (identity.expectedRepo) console.log(`Expected repo: ${identity.expectedRepo}`);
  if (identity.repoMatches !== null) console.log(`Repo matches: ${identity.repoMatches ? "yes" : "no"}`);
}

async function doctorCommand(flags) {
  const checks = [];
  let ok = true;

  try {
    const state = await getVerifiedState(flags.context);
    checks.push(pass("manifest", `${MANIFEST_FILE} is valid`));
    checks.push(pass("identity", state.verification.reason));

    const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
    const secrets = await secretBackend.listReferences(state.context.secrets);
    const missing = secrets.filter((secret) => !secret.configured);
    if (missing.length > 0) {
      checks.push(warn("secrets", `${missing.length} secret reference(s) are not in local store; environment variables may still satisfy runtime`));
    } else {
      checks.push(pass("secrets", "All context secret references are configured locally"));
    }
  } catch (error) {
    ok = false;
    checks.push(fail(error.code ?? "error", error.message));
  }

  const payload = { ok, checks };
  if (flags.json) return printJson(payload);
  for (const check of checks) {
    console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  if (!ok) process.exitCode = 1;
}

async function runCommand(args, flags, passthrough) {
  const command = passthrough.length > 0 ? passthrough : args;
  const state = await getVerifiedState(flags.context);
  const confirmed = flags.yes || process.env.KEYRAIL_CONFIRM === "1";
  const decision = evaluatePolicy({
    command,
    context: state.context,
    policy: state.manifest.policy,
    confirmed
  });

  if (!decision.allowed) {
    throw new KeyrailError(decision.requiresConfirmation ? "CONFIRMATION_REQUIRED" : "POLICY_DENIED", decision.reason);
  }

  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await backend.resolveReferences(state.context.secrets);
  const childEnv = { ...process.env, ...secrets.env };
  const secretValues = Object.values(secrets.env);
  const audit = {
    at: new Date().toISOString(),
    project: state.manifest.project.id,
    context: state.context.name,
    command: normalizeCommand(command),
    injected: secrets.resolved.map(({ provider, reference, envName }) => ({ provider, reference, envName })),
    missing: secrets.missing
  };

  console.error(`keyrail: running ${audit.command} in ${audit.project}/${audit.context}`);
  if (secrets.missing.length > 0) {
    console.error(`keyrail: ${secrets.missing.length} secret reference(s) missing; running without those values`);
  }

  const exitCode = await spawnRedacted(command, childEnv, secretValues);
  await appendAudit(state.root, audit);
  process.exitCode = exitCode;
}

async function handoffCommand(flags) {
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  const payload = {
    project: state.manifest.project,
    context: {
      name: state.context.name,
      risk: state.context.risk,
      requireConfirmation: state.context.requireConfirmation
    },
    root: state.root,
    identity: {
      gitRemote: state.identity.gitRemote,
      verified: true,
      reason: state.verification.reason
    },
    secrets: secrets.map(({ provider, reference, configured }) => ({ provider, reference, configured })),
    policy: state.manifest.policy
  };

  if (flags.json) return printJson(payload);
  console.log(`# Keyrail handoff`);
  console.log(`Project: ${payload.project.name} (${payload.project.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context.name} (${payload.context.risk})`);
  console.log(`Identity: ${payload.identity.reason}`);
  printSecretReferences(payload.secrets);
}

async function secretsCommand(args, flags) {
  if (args[0] !== "list") {
    throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail secrets list");
  }
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  if (flags.json) return printJson(secrets);
  printSecretReferences(secrets);
}

async function serveCommand(flags) {
  const { createServer } = await import("node:http");
  const port = Number(flags.port ?? 7788);
  const host = flags.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /") {
        const html = await renderUiHtml(process.cwd());
        send(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (route === "GET /api/state") {
        const state = await getStateForUi(process.cwd(), url.searchParams.get("context"));
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(state));
        return;
      }

      if (route === "POST /api/context") {
        const body = await readJsonBody(req);
        const loaded = await loadManifest(process.cwd());
        getContext(loaded.manifest, body.context);
        await writeContextLock(loaded.root, { project: loaded.manifest.project.id, context: body.context });
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, context: body.context }));
        return;
      }

      if (route === "POST /api/manifest") {
        const body = await readJsonBody(req);
        const loaded = await loadManifest(process.cwd());
        const nextManifest = {
          project: body.project ?? loaded.manifest.project,
          contexts: body.contexts ?? loaded.manifest.contexts,
          policy: body.policy ?? loaded.manifest.policy
        };
        await writeManifest(loaded.root, nextManifest);
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }

      if (route === "POST /api/secret") {
        const body = await readJsonBody(req);
        const loaded = await loadManifest(process.cwd());
        const backend = createSecretBackend({ type: "local-file", root: loaded.root });
        await backend.set(body.reference, body.value);
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }

      if (route === "GET /api/audit") {
        const audit = await readAuditLog(process.cwd());
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(audit));
        return;
      }

      send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not_found" }));
    } catch (error) {
      send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code ?? "error" }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch((error) => {
    throw new KeyrailError("UI_SERVER_ERROR", `Unable to start UI server on ${host}:${port}`, {
      code: error.code,
      address: error.address,
      port: error.port
    });
  });

  console.log(`Keyrail UI running at http://${host}:${port}`);
}

async function getVerifiedState(contextName) {
  const loaded = await loadManifest(process.cwd());
  const activeContextName = await resolveActiveContextName(loaded.root, loaded.manifest, contextName);
  const context = getContext(loaded.manifest, activeContextName);
  const identity = await identifyProject(loaded.root, loaded.manifest);
  const verification = verifyIdentity(identity, loaded.manifest);
  return { ...loaded, context, identity, verification };
}

function parseArgs(argv) {
  const passthroughIndex = argv.indexOf("--");
  const before = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  const passthrough = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
  const [command, ...rawArgs] = before;
  const flags = {};
  const args = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg.startsWith("--") && rawArgs[index + 1] && !rawArgs[index + 1].startsWith("--")) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = true;
    } else {
      args.push(arg);
    }
  }

  return { command, args, flags, passthrough };
}

function printSecretReferences(secrets) {
  if (!secrets.length) {
    console.log("Secrets: none");
    return;
  }
  console.log("Secrets:");
  for (const secret of secrets) {
    console.log(`- ${secret.provider}: ${secret.reference} (${secret.configured ? "configured" : "reference only"})`);
  }
}

async function spawnRedacted(command, env, secretValues) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => process.stdout.write(redactSecrets(chunk.toString(), secretValues)));
    child.stderr.on("data", (chunk) => process.stderr.write(redactSecrets(chunk.toString(), secretValues)));
    child.on("error", reject);
    child.on("close", resolve);
  });
}

async function appendAudit(root, audit) {
  const dir = path.join(root, ".keyrail");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(audit)}\n`;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path.join(dir, "audit.log"), line, { mode: 0o600 });
}

function pass(name, message) {
  return { name, status: "pass", message };
}

function warn(name, message) {
  return { name, status: "warn", message };
}

function fail(name, message) {
  return { name, status: "fail", message };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Keyrail

Usage:
  keyrail init [--id <id>] [--name <name>] [--repo <url|local>] [--context <name>]
  keyrail bind [--context <name>]
  keyrail current [--json] [--context <name>]
  keyrail identify [--json]
  keyrail doctor [--json] [--context <name>]
  keyrail run [--context <name>] [--yes] -- <command>
  keyrail handoff [--json] [--context <name>]
  keyrail secrets list [--json] [--context <name>]
  keyrail ui [--port <port>]
`);
}

function titleize(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function getStateForUi(root = process.cwd(), requestedContext = null) {
  const loaded = await loadManifest(root);
  const activeContext = await resolveActiveContextName(loaded.root, loaded.manifest, requestedContext ?? undefined);
  const context = getContext(loaded.manifest, activeContext);
  const identity = await identifyProject(loaded.root, loaded.manifest);
  const verification = verifyIdentity(identity, loaded.manifest);
  const backend = createSecretBackend({ type: "local-file", root: loaded.root });
  const secrets = await backend.listReferences(context.secrets);
  const audit = await readAuditLog(loaded.root);
  return {
    root: loaded.root,
    project: loaded.manifest.project,
    contexts: Object.values(loaded.manifest.contexts),
    context,
    identity,
    verification,
    secrets,
    audit,
    policy: loaded.manifest.policy,
    activeContext
  };
}

async function readAuditLog(root) {
  const auditPath = path.join(root, ".keyrail", "audit.log");
  try {
    const raw = await readFile(auditPath, "utf8");
    return raw.trim().split("\n").filter(Boolean).slice(-50).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function renderUiHtml(root = process.cwd()) {
  const state = await getStateForUi(root);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Keyrail</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #f5f7fb; --panel: #ffffff; --border: #d7dbe7; --text: #101828; --muted: #667085; --accent: #2563eb; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header, section { padding: 16px 20px; border-bottom: 1px solid var(--border); }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; background: var(--panel); position: sticky; top: 0; }
    main { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 64px); }
    aside, article { padding: 20px; }
    aside { border-right: 1px solid var(--border); background: #fafbff; }
    button, select, textarea, input { font: inherit; }
    button { border: 1px solid var(--border); background: var(--panel); padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    button.primary { background: var(--accent); color: white; border-color: var(--accent); }
    .stack { display:grid; gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
    .muted { color: var(--muted); font-size: 14px; }
    .contexts { display:flex; flex-wrap:wrap; gap:8px; }
    .context-btn.active { background: #dbeafe; border-color: #93c5fd; }
    textarea { width: 100%; min-height: 280px; border: 1px solid var(--border); border-radius: 10px; padding: 12px; box-sizing: border-box; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .toolbar { display:flex; gap: 8px; flex-wrap: wrap; align-items:center; }
    .tag { display:inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <strong>Keyrail</strong>
      <span class="muted">local project identity and credential routing</span>
    </div>
    <div class="toolbar">
      <button class="primary" onclick="saveManifest()">Save manifest</button>
      <button onclick="refreshState()">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="stack">
        <div class="card">
          <div class="muted">Project</div>
          <h2 id="project-name">${escapeHtml(state.project.name)}</h2>
          <div class="muted" id="project-id">${escapeHtml(state.project.id)}</div>
          <div class="tag" id="verification">${state.verification.reason}</div>
        </div>
        <div class="card">
          <div class="muted">Context</div>
          <div class="contexts" id="context-list"></div>
        </div>
        <div class="card">
          <div class="muted">Secrets</div>
          <div id="secret-list"></div>
        </div>
      </div>
    </aside>
    <article>
      <div class="split">
        <section class="card">
          <div class="muted">Manifest</div>
          <textarea id="manifest-editor"></textarea>
        </section>
        <section class="card">
          <div class="muted">Audit</div>
          <pre id="audit-log"></pre>
        </section>
      </div>
    </article>
  </main>
  <script>
    const state = ${JSON.stringify(state)};
    const editor = document.getElementById('manifest-editor');
    const contextList = document.getElementById('context-list');
    const secretList = document.getElementById('secret-list');
    const auditLog = document.getElementById('audit-log');
    editor.value = ${JSON.stringify(stringifyManifestForEditor(state))};
    render();

    async function refreshState() {
      location.reload();
    }

    async function saveManifest() {
      const manifest = window.__manifestDraft || {};
      await fetch('/api/manifest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
      location.reload();
    }

    async function switchContext(name) {
      await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: name }) });
      location.reload();
    }

    function render() {
      contextList.innerHTML = state.contexts.map((context) => '<button class="context-btn' + (context.name === state.activeContext ? ' active' : '') + '" onclick="switchContext(\\'' + escapeJs(context.name) + '\\')">' + escapeHtml(context.name) + '</button>').join('');
      secretList.innerHTML = state.secrets.length
        ? state.secrets.map((secret) => '<div>' + escapeHtml(secret.provider) + ': <span class="muted">' + escapeHtml(secret.reference) + '</span></div>').join('')
        : '<div class="muted">No secrets</div>';
      auditLog.textContent = state.audit?.length ? state.audit.map((entry) => JSON.stringify(entry, null, 2)).join('\\n\\n') : 'No audit entries';
      window.__manifestDraft = stateToManifest(state, editor.value);
    }

    editor.addEventListener('input', () => { window.__manifestDraft = stateToManifest(state, editor.value); });

    function stateToManifest(state, text) {
      try {
        return JSON.parse(text);
      } catch {
      return {
        project: state.project,
        contexts: Object.fromEntries(state.contexts.map((context) => [context.name, context])),
        policy: state.policy
      };
    }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>\\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }

    function escapeJs(value) {
      return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }
  </script>
</body>
</html>`;
}

function stringifyManifestForEditor(state) {
  return JSON.stringify({
    project: state.project,
    contexts: Object.fromEntries(state.contexts.map((context) => [context.name, context])),
    policy: state.policy
  }, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function send(res, statusCode, contentType, body) {
  res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
