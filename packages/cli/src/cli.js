import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { GlobalSecretStore, createSecretBackend, getKeyrailConfigRoot, redactSecrets } from "@keyrail/backends";
import {
  KeyrailError,
  MANIFEST_FILE,
  getContext,
  identifyProject,
  loadManifest,
  removeContext,
  removeSecretReference,
  resolveActiveContextName,
  setSecretReference,
  upsertContext,
  validateManifest,
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
    case "link":
      return linkCommand(args, flags);
    case "unlink":
      return unlinkCommand(args, flags);
    case "projects":
      return projectsCommand(args, flags);
    case "profile":
      return profileCommand(args, flags);
    case "clone":
      return cloneCommand(args, flags);
    case "secrets":
      return secretsCommand(args, flags);
    case "context":
      return contextCommand(args, flags);
    case "policy":
      return policyCommand(args, flags);
    case "audit":
      return auditCommand(args, flags);
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
  const services = secrets.map((secret) => ({
    service: secret.provider,
    reference: secret.reference,
    envName: secret.envName,
    configured: secret.configured
  }));
  const payload = {
    project: state.manifest.project,
    context: state.context,
    identity: state.identity,
    services,
    agent: {
      verified: true,
      instruction: "Use keyrail run -- <command> so this project receives only its linked service keys."
    }
  };

  if (flags.json) return printJson(payload);
  console.log(`${state.manifest.project.name} (${state.manifest.project.id})`);
  console.log(`Root: ${state.root}`);
  console.log(`Context: ${state.context.name} (${state.context.risk})`);
  console.log(`Identity: ${state.verification.reason}`);
  printServiceLinks(services);
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
  const confirmed = await resolveConfirmation(flags, state);
  const decision = evaluatePolicy({
    command,
    context: state.context,
    policy: state.manifest.policy,
    confirmed
  });

  if (!decision.allowed) {
    await appendAudit(state.root, {
      at: new Date().toISOString(),
      project: state.manifest.project.id,
      context: state.context.name,
      command: normalizeCommand(command),
      decision: decision.requiresConfirmation ? "confirmation_required" : "denied",
      reason: decision.reason,
      injected: [],
      missing: []
    });
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
    decision: "allowed",
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

async function linkCommand(args, flags) {
  const service = args[0] ?? flags.service;
  const reference = args[1] ?? flags.reference;
  if (!service || !reference) {
    throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail link <service> <reference> [--value <secret>]");
  }

  const loaded = await loadManifest(process.cwd());
  const contextName = await resolveActiveContextName(loaded.root, loaded.manifest, flags.context);
  setSecretReference(loaded.manifest, contextName, service, reference);
  await writeManifest(loaded.root, loaded.manifest);

  if (flags.value) {
    const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: loaded.root });
    await backend.set(reference, flags.value);
  }

  console.log(`Linked ${service} to ${reference} for ${loaded.manifest.project.id}/${contextName}`);
}

async function unlinkCommand(args, flags) {
  const service = args[0] ?? flags.service;
  if (!service) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail unlink <service>");

  const loaded = await loadManifest(process.cwd());
  const contextName = await resolveActiveContextName(loaded.root, loaded.manifest, flags.context);
  const reference = getContext(loaded.manifest, contextName).secrets[service];
  removeSecretReference(loaded.manifest, contextName, service);
  await writeManifest(loaded.root, loaded.manifest);

  if (flags.deleteValue && reference) {
    const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: loaded.root });
    if (typeof backend.unset === "function") await backend.unset(reference);
  }

  console.log(`Unlinked ${service} from ${loaded.manifest.project.id}/${contextName}`);
}

async function projectsCommand(args, flags) {
  const state = await getVerifiedState(flags.context);
  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const services = await backend.listReferences(state.context.secrets);
  const payload = {
    active: true,
    id: state.manifest.project.id,
    name: state.manifest.project.name,
    root: state.root,
    context: state.context.name,
    services: services.map((service) => ({
      service: service.provider,
      reference: service.reference,
      configured: service.configured
    }))
  };

  if (flags.json) return printJson([payload]);
  console.log(`${payload.name} (${payload.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context}`);
  printServiceLinks(payload.services);
}

async function profileCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const profilePath = getProfilePath();

  if (subcommand === "list") {
    const profile = await readProfile();
    if (flags.json) return printJson(profile);
    if (!Object.keys(profile.services).length) {
      console.log("Profiles: none");
      return;
    }
    console.log("Profiles:");
    for (const [service, entry] of Object.entries(profile.services)) {
      console.log(`- ${service}: ${entry.reference}`);
    }
    return;
  }

  if (subcommand === "set") {
    const service = args[1] ?? flags.service;
    const reference = args[2] ?? flags.reference;
    const value = flags.value ?? (flags.valueStdin ? await readStdin() : null);
    if (!service || !reference) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail profile set <service> <reference> [--value <secret>|--value-stdin]");
    const profile = await readProfile();
    profile.services[service] = { reference };
    await writeProfile(profilePath, profile);
    if (value) await new GlobalSecretStore().set(reference, value);
    console.log(`Saved ${service} profile ${reference}`);
    return;
  }

  if (subcommand === "unset") {
    const service = args[1] ?? flags.service;
    if (!service) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail profile unset <service>");
    const profile = await readProfile();
    const reference = profile.services[service]?.reference;
    delete profile.services[service];
    await writeProfile(profilePath, profile);
    if (flags.deleteValue && reference) await new GlobalSecretStore().unset(reference);
    console.log(`Removed ${service} profile`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail profile list|set|unset");
}

async function cloneCommand(args, flags) {
  const service = args[0];
  if (service !== "github") throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail clone github <owner/repo> [directory]");
  const repo = args[1] ?? flags.repo;
  const target = args[2] ?? flags.directory;
  if (!repo) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail clone github <owner/repo> [directory]");

  const profile = await readProfile();
  const reference = flags.reference ?? profile.services.github?.reference;
  if (!reference) {
    throw new KeyrailError("PROFILE_NOT_FOUND", "No GitHub profile configured. Run keyrail profile set github <reference> --value-stdin");
  }

  const token = await new GlobalSecretStore().get(reference);
  if (!token) {
    throw new KeyrailError("SECRET_NOT_FOUND", `No value found for ${reference}. Run keyrail profile set github ${reference} --value-stdin`);
  }

  const url = normalizeGithubRepoUrl(repo);
  const exitCode = await gitCloneWithToken(url, target, token);
  process.exitCode = exitCode;
}

async function secretsCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });

  if (subcommand === "list") {
    const secrets = await secretBackend.listReferences(state.context.secrets);
    if (flags.json) return printJson(secrets);
    printSecretReferences(secrets);
    return;
  }

  if (subcommand === "set") {
    const provider = args[1] ?? flags.provider;
    const reference = args[2] ?? flags.reference;
    const value = flags.value ?? args[3];
    if (!provider || !reference) {
      throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail secrets set <provider> <reference> [--value <value>]");
    }
    const loaded = await loadManifest(process.cwd());
    const contextName = await resolveActiveContextName(loaded.root, loaded.manifest, flags.context);
    setSecretReference(loaded.manifest, contextName, provider, reference);
    await writeManifest(loaded.root, loaded.manifest);
    if (value) await secretBackend.set(reference, value);
    console.log(`Set ${provider} reference in ${contextName}`);
    return;
  }

  if (subcommand === "unset") {
    const provider = args[1] ?? flags.provider;
    if (!provider) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail secrets unset <provider>");
    const loaded = await loadManifest(process.cwd());
    const contextName = await resolveActiveContextName(loaded.root, loaded.manifest, flags.context);
    const reference = getContext(loaded.manifest, contextName).secrets[provider];
    removeSecretReference(loaded.manifest, contextName, provider);
    await writeManifest(loaded.root, loaded.manifest);
    if (flags.deleteValue && reference && typeof secretBackend.unset === "function") await secretBackend.unset(reference);
    console.log(`Removed ${provider} reference from ${contextName}`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail secrets list|set|unset");
}

async function contextCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const loaded = await loadManifest(process.cwd());

  if (subcommand === "list") {
    const active = await resolveActiveContextName(loaded.root, loaded.manifest, flags.context);
    const contexts = Object.values(loaded.manifest.contexts).map((context) => ({
      name: context.name,
      risk: context.risk,
      requireConfirmation: context.requireConfirmation,
      active: context.name === active
    }));
    if (flags.json) return printJson(contexts);
    for (const context of contexts) {
      console.log(`${context.active ? "*" : " "} ${context.name} (${context.risk})${context.requireConfirmation ? " confirm" : ""}`);
    }
    return;
  }

  if (subcommand === "use") {
    const name = args[1] ?? flags.context;
    getContext(loaded.manifest, name);
    await writeContextLock(loaded.root, { project: loaded.manifest.project.id, context: name });
    console.log(`Using context ${name}`);
    return;
  }

  if (subcommand === "add") {
    const name = args[1] ?? flags.name;
    upsertContext(loaded.manifest, name, {
      risk: flags.risk ?? "low",
      requireConfirmation: Boolean(flags.requireConfirmation ?? flags.confirm)
    });
    await writeManifest(loaded.root, loaded.manifest);
    console.log(`Added context ${name}`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1] ?? flags.name;
    removeContext(loaded.manifest, name);
    await writeManifest(loaded.root, loaded.manifest);
    console.log(`Removed context ${name}`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail context list|use|add|remove");
}

async function policyCommand(args, flags) {
  const subcommand = args[0] ?? "show";
  const loaded = await loadManifest(process.cwd());

  if (subcommand === "show") {
    if (flags.json) return printJson(loaded.manifest.policy);
    console.log("Allow:");
    for (const item of loaded.manifest.policy.allow) console.log(`- ${item}`);
    console.log("Require confirm:");
    for (const item of loaded.manifest.policy.requireConfirm) console.log(`- ${item}`);
    console.log("Deny:");
    for (const item of loaded.manifest.policy.deny) console.log(`- ${item}`);
    return;
  }

  const listName = {
    "allow": "allow",
    "deny": "deny",
    "require-confirm": "requireConfirm"
  }[subcommand];
  if (!listName) throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail policy show|allow|deny|require-confirm <command>");

  const command = args.slice(1).join(" ") || flags.command;
  if (!command) throw new KeyrailError("INVALID_ARGUMENTS", `Use keyrail policy ${subcommand} <command>`);
  if (!loaded.manifest.policy[listName].includes(command)) loaded.manifest.policy[listName].push(command);
  validateManifest(loaded.manifest);
  await writeManifest(loaded.root, loaded.manifest);
  console.log(`Added policy ${subcommand}: ${command}`);
}

async function auditCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  if (subcommand !== "list") throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail audit list");
  const loaded = await loadManifest(process.cwd());
  const audit = await readAuditLog(loaded.root, Number(flags.limit ?? 50));
  if (flags.json) return printJson(audit);
  if (!audit.length) {
    console.log("Audit: none");
    return;
  }
  for (const entry of audit) {
    console.log(`${entry.at} ${entry.project}/${entry.context} ${entry.decision ?? "allowed"} ${entry.command}`);
  }
}

async function serveCommand(flags) {
  const { createServer } = await import("node:http");
  const port = Number(flags.port ?? 7788);
  const host = flags.host ?? "127.0.0.1";
  const token = flags.token ?? process.env.KEYRAIL_UI_TOKEN ?? randomBytes(18).toString("base64url");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /") {
        if (!isUiRequestAuthorized(req, url, token)) return sendUnauthorized(res);
        const html = await renderUiHtml(process.cwd(), token);
        send(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (url.pathname.startsWith("/api/") && !isUiRequestAuthorized(req, url, token)) {
        sendUnauthorized(res);
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

  console.log(`Keyrail UI running at http://${host}:${port}/?token=${token}`);
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

function printServiceLinks(services) {
  if (!services.length) {
    console.log("Linked services: none");
    return;
  }
  console.log("Linked services:");
  for (const service of services) {
    const name = service.service ?? service.provider;
    console.log(`- ${name}: ${service.reference} (${service.configured ? "configured" : "reference only"})`);
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

async function resolveConfirmation(flags, state) {
  if (flags.yes || process.env.KEYRAIL_CONFIRM === "1") return true;
  const context = state.context;
  const needsPrompt = context.risk === "high" || context.requireConfirmation;
  if (!needsPrompt) return false;

  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const expected = `${state.manifest.project.id}/${context.name}`;
    const answer = await rl.question(`Type ${expected} to confirm high-risk execution: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`Keyrail

Usage:
  keyrail init [--id <id>] [--name <name>] [--repo <url|local>] [--context <name>]
  keyrail link <service> <reference> [--value <secret>]
  keyrail unlink <service>
  keyrail profile set github <reference> [--value-stdin]
  keyrail clone github <owner/repo> [directory]
  keyrail current [--json] [--context <name>]
  keyrail run [--context <name>] [--yes] -- <command>
  keyrail ui [--port <port>] [--token <token>]

Advanced:
  keyrail bind [--context <name>]
  keyrail identify [--json]
  keyrail doctor [--json] [--context <name>]
  keyrail projects [--json]
  keyrail profile list|set|unset
  keyrail context list|use|add|remove
  keyrail policy show|allow|deny|require-confirm
  keyrail handoff [--json] [--context <name>]
  keyrail secrets list|set|unset [--context <name>]
  keyrail audit list [--json]
`);
}

function titleize(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getProfilePath() {
  return path.join(getKeyrailConfigRoot(), "profiles.json");
}

async function readProfile() {
  try {
    const raw = await readFile(getProfilePath(), "utf8");
    const profile = JSON.parse(raw);
    return { version: 1, services: {}, ...profile, services: profile.services ?? {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, services: {} };
    throw error;
  }
}

async function writeProfile(profilePath, profile) {
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

export function normalizeGithubRepoUrl(repo) {
  if (repo.startsWith("https://") || repo.startsWith("git@")) return repo;
  return `https://github.com/${repo.replace(/\.git$/, "")}.git`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))).toString("utf8").trim();
}

async function gitCloneWithToken(url, target, token) {
  const tempDir = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "keyrail-git-")));
  const askpassPath = path.join(tempDir, "askpass.sh");
  await writeFile(
    askpassPath,
    `#!/bin/sh\ncase "$1" in\n*Username*) printf '%s\\n' x-access-token ;;\n*) printf '%s\\n' "$KEYRAIL_GITHUB_TOKEN" ;;\nesac\n`,
    { mode: 0o700 }
  );

  const args = ["clone", url];
  if (target) args.push(target);
  try {
    return await spawnRedacted(["git", ...args], {
      ...process.env,
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0",
      KEYRAIL_GITHUB_TOKEN: token
    }, [token]);
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
  }
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
    services: secrets.map((secret) => ({
      service: secret.provider,
      reference: secret.reference,
      envName: secret.envName,
      configured: secret.configured
    })),
    audit,
    policy: loaded.manifest.policy,
    activeContext
  };
}

async function readAuditLog(root, limit = 50) {
  const auditPath = path.join(root, ".keyrail", "audit.log");
  try {
    const raw = await readFile(auditPath, "utf8");
    return raw.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function renderUiHtml(root = process.cwd(), token = "") {
  const state = await getStateForUi(root);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Keyrail</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #f5f7fb; --panel: #ffffff; --border: #d7dbe7; --text: #101828; --muted: #667085; --accent: #2563eb; --ok: #14804a; --warn: #b54708; }
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
    .service-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
    .service-row:last-child { border-bottom:0; }
    .status-ok { color: var(--ok); }
    .status-warn { color: var(--warn); }
    code { background:#f2f4f7; padding:2px 6px; border-radius:6px; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <strong>Keyrail</strong>
      <span class="muted">project keys for local agents</span>
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
          <div class="muted">Services</div>
          <div id="secret-list"></div>
        </div>
      </div>
    </aside>
    <article>
      <div class="split">
        <section class="card">
          <div class="muted">Agent Command</div>
          <p>Run project commands through <code>keyrail run -- &lt;command&gt;</code>.</p>
          <p class="muted">Keyrail verifies this project and injects only the linked service keys for the active context.</p>
        </section>
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
      await apiFetch('/api/manifest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
      location.reload();
    }

    async function switchContext(name) {
      await apiFetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: name }) });
      location.reload();
    }

    function apiFetch(path, options = {}) {
      const headers = Object.assign({}, options.headers || {}, { 'x-keyrail-token': ${JSON.stringify(token)} });
      return fetch(path, Object.assign({}, options, { headers }));
    }

    function render() {
      contextList.innerHTML = state.contexts.map((context) => '<button class="context-btn' + (context.name === state.activeContext ? ' active' : '') + '" onclick="switchContext(\\'' + escapeJs(context.name) + '\\')">' + escapeHtml(context.name) + '</button>').join('');
      secretList.innerHTML = state.services.length
        ? state.services.map((service) => '<div class="service-row"><div><strong>' + escapeHtml(service.service) + '</strong><div class="muted">' + escapeHtml(service.reference) + ' -> ' + escapeHtml(service.envName) + '</div></div><span class="' + (service.configured ? 'status-ok' : 'status-warn') + '">' + (service.configured ? 'Ready' : 'Reference only') + '</span></div>').join('')
        : '<div class="muted">No services linked yet. Use keyrail link github my-github-key.</div>';
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

function isUiRequestAuthorized(req, url, token) {
  if (!token) return true;
  const provided = req.headers["x-keyrail-token"] ?? url.searchParams.get("token");
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(token);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function sendUnauthorized(res) {
  send(res, 401, "application/json; charset=utf-8", JSON.stringify({ error: "unauthorized" }));
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
