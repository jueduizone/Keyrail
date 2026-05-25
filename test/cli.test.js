import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getStateForUi, renderUiHtml } from "../packages/cli/src/cli.js";

const CLI = path.resolve("packages/cli/bin/keyrail.js");

test("init creates a manifest and current reads it", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-cli-"));

  const init = run(["init", "--id", "demo", "--name", "Demo", "--repo", "local"], cwd);
  assert.equal(init.status, 0, init.stderr);

  const manifest = await readFile(path.join(cwd, ".agent-context.yaml"), "utf8");
  assert.match(manifest, /id: demo/);

  const current = run(["current", "--json"], cwd);
  assert.equal(current.status, 0, current.stderr);
  const payload = JSON.parse(current.stdout);
  assert.equal(payload.project.id, "demo");
  assert.equal(payload.context.name, "local");
});

test("run redacts injected secrets from child output", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-run-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const manifestPath = path.join(cwd, ".agent-context.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest.replace("secrets: {}", "secrets:\n      openai: demo-openai").replace("allow:\n    - gh issue list", "allow:\n    - node -e")
  );
  await mkdir(path.join(cwd, ".keyrail"), { recursive: true });
  await writeFile(path.join(cwd, ".keyrail", "secrets.local.json"), JSON.stringify({ "demo-openai": "DUMMY_OPENAI_TOKEN_FOR_TESTS" }));

  const result = run(["run", "--", "node", "-e", "console.log(process.env.OPENAI_API_KEY)"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_OPENAI_TOKEN_FOR_TESTS/);
});

test("ui renders current project state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-ui-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  await writeFile(
    path.join(cwd, ".agent-context.yaml"),
    (await readFile(path.join(cwd, ".agent-context.yaml"), "utf8")).replace(
      "contexts:\n  local:\n    risk: low\n    secrets: {}\n",
      "contexts:\n  local:\n    risk: low\n    secrets: {}\n  staging:\n    risk: medium\n    secrets: {}\n"
    )
  );

  const state = await getStateForUi(cwd);
  assert.equal(state.activeContext, "local");
  assert.equal(state.contexts.length, 2);

  const html = await renderUiHtml(cwd);
  assert.match(html, /Keyrail/);
  assert.match(html, /manifest-editor/);
  assert.match(html, /Agent Command/);
  assert.match(html, /Services/);
});

test("context and secret management commands update the manifest", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-manage-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const addContext = run(["context", "add", "staging", "--risk", "medium"], cwd);
  assert.equal(addContext.status, 0, addContext.stderr);

  const useContext = run(["context", "use", "staging"], cwd);
  assert.equal(useContext.status, 0, useContext.stderr);

  const setSecret = run(["secrets", "set", "openai", "demo-openai"], cwd);
  assert.equal(setSecret.status, 0, setSecret.stderr);

  const current = run(["current", "--json"], cwd);
  assert.equal(current.status, 0, current.stderr);
  const payload = JSON.parse(current.stdout);
  assert.equal(payload.context.name, "staging");
  assert.deepEqual(payload.context.secrets, { openai: "demo-openai" });
});

test("link and unlink provide the simple service routing workflow", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-link-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const link = run(["link", "vercel", "demo-vercel"], cwd);
  assert.equal(link.status, 0, link.stderr);

  const current = run(["current", "--json"], cwd);
  assert.equal(current.status, 0, current.stderr);
  const payload = JSON.parse(current.stdout);
  assert.equal(payload.services[0].service, "vercel");
  assert.equal(payload.services[0].envName, "VERCEL_TOKEN");
  assert.match(payload.agent.instruction, /keyrail run/);

  const projects = run(["projects", "--json"], cwd);
  assert.equal(projects.status, 0, projects.stderr);
  assert.equal(JSON.parse(projects.stdout)[0].services[0].service, "vercel");

  const unlink = run(["unlink", "vercel"], cwd);
  assert.equal(unlink.status, 0, unlink.stderr);
  const after = JSON.parse(run(["current", "--json"], cwd).stdout);
  assert.deepEqual(after.services, []);
});

test("attach status and detach provide the human-friendly service routing workflow", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-attach-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const attach = run(["attach", "vercel", "demo-vercel"], cwd);
  assert.equal(attach.status, 0, attach.stderr);

  const status = run(["status", "--json"], cwd);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.services[0].service, "vercel");
  assert.equal(payload.services[0].reference, "demo-vercel");

  const detach = run(["detach", "vercel"], cwd);
  assert.equal(detach.status, 0, detach.stderr);
  assert.deepEqual(JSON.parse(run(["status", "--json"], cwd).stdout).services, []);
});

test("attach and run work without project init or project files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-zero-init-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-zero-home-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "zero-init-demo" }));
  await mkdir(path.join(cwd, "src"), { recursive: true });

  const projectCwd = path.join(cwd, "src");
  const initialStatus = run(["status", "--json"], projectCwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(initialStatus.status, 0, initialStatus.stderr);
  assert.equal(JSON.parse(initialStatus.stdout).project.id, "zero-init-demo");
  await assert.rejects(readFile(path.join(keyrailHome, "projects.json"), "utf8"), { code: "ENOENT" });

  const attach = run(["attach", "openai", "zero-openai", "--value", "DUMMY_ZERO_OPENAI_TOKEN"], projectCwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(attach.status, 0, attach.stderr);

  const status = run(["status", "--json"], projectCwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.project.id, "zero-init-demo");
  assert.equal(payload.services[0].service, "openai");
  assert.equal(payload.services[0].configured, true);

  const allow = run(["policy", "allow", "node -e"], projectCwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(allow.status, 0, allow.stderr);

  const result = run(["run", "--", "node", "-e", "console.log(process.env.OPENAI_API_KEY)"], projectCwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_ZERO_OPENAI_TOKEN/);

  await assert.rejects(readFile(path.join(cwd, ".agent-context.yaml"), "utf8"), { code: "ENOENT" });
  await assert.rejects(stat(path.join(cwd, ".ctx")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(cwd, ".keyrail")), { code: "ENOENT" });

  const store = JSON.parse(await readFile(path.join(keyrailHome, "projects.json"), "utf8"));
  assert.equal(Object.values(store.projects)[0].manifest.contexts.local.secrets.openai, "zero-openai");

  const audit = run(["audit", "list", "--json"], projectCwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).at(-1).decision, "allowed");

  const detach = run(["detach", "openai", "--delete-value"], projectCwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(detach.status, 0, detach.stderr);
  const secretsAfterDetach = JSON.parse(await readFile(path.join(keyrailHome, "secrets.global.json"), "utf8"));
  assert.equal(secretsAfterDetach["zero-openai"], undefined);
});

test("profile commands use a user-level config root for private repo bootstrap", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-profile-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-home-"));

  const set = run(["profile", "set", "github", "personal-github", "--value", "DUMMY_GITHUB_TOKEN_FOR_TESTS"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(set.status, 0, set.stderr);
  assert.doesNotMatch(set.stdout, /DUMMY_GITHUB_TOKEN_FOR_TESTS/);

  const profile = JSON.parse(await readFile(path.join(keyrailHome, "profiles.json"), "utf8"));
  assert.equal(profile.services.github.reference, "personal-github");

  const secrets = JSON.parse(await readFile(path.join(keyrailHome, "secrets.global.json"), "utf8"));
  assert.equal(secrets["personal-github"], "DUMMY_GITHUB_TOKEN_FOR_TESTS");

  const list = run(["profile", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).services.github.reference, "personal-github");

  const unset = run(["profile", "unset", "github", "--delete-value"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(unset.status, 0, unset.stderr);
  const after = JSON.parse(await readFile(path.join(keyrailHome, "secrets.global.json"), "utf8"));
  assert.equal(after["personal-github"], undefined);
});

test("auth commands manage user-level service accounts", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-auth-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-auth-home-"));

  const add = run(["auth", "add", "github", "personal", "--value-stdin"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }, "DUMMY_AUTH_GITHUB_TOKEN\n");
  assert.equal(add.status, 0, add.stderr);

  const list = run(["auth", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).services.github.reference, "personal");
  assert.equal(JSON.parse(list.stdout).accounts.github.personal.reference, "personal");

  const remove = run(["auth", "remove", "github", "personal", "--delete-value"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(remove.status, 0, remove.stderr);
  const after = JSON.parse(run(["auth", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout);
  assert.deepEqual(after.services, {});
  assert.deepEqual(after.accounts, {});
});

test("auth can keep multiple accounts for the same service", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-auth-multi-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-auth-multi-home-"));

  assert.equal(run(["auth", "add", "github", "personal", "--value", "DUMMY_PERSONAL_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);
  assert.equal(run(["auth", "add", "github", "work", "--value", "DUMMY_WORK_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const listed = JSON.parse(run(["auth", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout);
  assert.deepEqual(Object.keys(listed.accounts.github).sort(), ["personal", "work"]);
  assert.equal(listed.services.github.reference, "work");

  const personal = run(["with", "github", "personal", "--", "node", "-e", "console.log(process.env.GITHUB_TOKEN)"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(personal.status, 0, personal.stderr);
  assert.match(personal.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(personal.stdout, /DUMMY_PERSONAL_GITHUB_TOKEN/);

  const removeWork = run(["auth", "remove", "github", "work", "--delete-value"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(removeWork.status, 0, removeWork.stderr);
  const after = JSON.parse(run(["auth", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout);
  assert.deepEqual(Object.keys(after.accounts.github), ["personal"]);
  assert.equal(after.services.github.reference, "personal");
});

test("profile set accepts secret values from stdin", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-profile-stdin-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-stdin-home-"));

  const set = run(["profile", "set", "github", "stdin-github", "--value-stdin"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }, "DUMMY_STDIN_GITHUB_TOKEN\n");
  assert.equal(set.status, 0, set.stderr);

  const secrets = JSON.parse(await readFile(path.join(keyrailHome, "secrets.global.json"), "utf8"));
  assert.equal(secrets["stdin-github"], "DUMMY_STDIN_GITHUB_TOKEN");
});

test("profile set rejects empty stdin unless explicitly allowed", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-profile-empty-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-empty-home-"));

  const empty = run(["auth", "add", "github", "empty-github", "--value-stdin"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }, "");
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Refusing to save empty secret/);

  const allowed = run(["auth", "add", "github", "empty-github", "--value-stdin", "--allow-empty"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }, "");
  assert.equal(allowed.status, 0, allowed.stderr);
  const profile = JSON.parse(await readFile(path.join(keyrailHome, "profiles.json"), "utf8"));
  assert.equal(profile.accounts.github["empty-github"].reference, "empty-github");
  const secrets = JSON.parse(await readFile(path.join(keyrailHome, "secrets.global.json"), "utf8"));
  assert.equal(secrets["empty-github"], "");
});

test("use injects a configured service key into a normal child command", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-use-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-use-home-"));

  const set = run(["profile", "set", "github", "personal-github", "--value", "DUMMY_USE_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(set.status, 0, set.stderr);

  const result = run(["use", "github", "--", "node", "-e", "console.log(process.env.GITHUB_TOKEN); console.error(process.env.GH_TOKEN)"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.match(result.stderr, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_USE_GITHUB_TOKEN/);
  assert.doesNotMatch(result.stderr, /DUMMY_USE_GITHUB_TOKEN/);
});

test("with injects a named service account into a normal child command", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-with-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-with-home-"));

  const add = run(["auth", "add", "github", "personal", "--value", "DUMMY_WITH_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(add.status, 0, add.stderr);

  const result = run(["with", "github", "personal", "--", "node", "-e", "console.log(process.env.GITHUB_TOKEN)"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_WITH_GITHUB_TOKEN/);
});

test("agent skill documents current state and private repo bootstrap", async () => {
  const skill = await readFile(path.resolve("agents/keyrail/SKILL.md"), "utf8");
  await stat(path.resolve("docs/agent/README.md"));
  assert.match(skill, /keyrail status --json/);
  assert.match(skill, /keyrail with github/);
  assert.match(skill, /keyrail auth list --json/);
  assert.match(skill, /Do not ask them to paste a token into chat/);
  assert.match(skill, /Never read, print, or copy raw secret values/);
});

test("policy and audit commands expose configured rules and run decisions", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-audit-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["policy", "allow", "node -e"], cwd).status, 0);

  const result = run(["run", "--", "node", "-e", "console.log('ok')"], cwd);
  assert.equal(result.status, 0, result.stderr);

  const audit = run(["audit", "list", "--json"], cwd);
  assert.equal(audit.status, 0, audit.stderr);
  const entries = JSON.parse(audit.stdout);
  assert.equal(entries.at(-1).decision, "allowed");
  assert.equal(entries.at(-1).command, "node -e console.log('ok')");
});

test("policy allow accepts a full command after --", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-passthrough-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-passthrough-home-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "policy-passthrough-demo" }));

  const allow = run(["policy", "allow", "--", "/bin/zsh", "-lc", "printf '%s' \"$TOKEN\" | npx vercel env add FOO production"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(allow.status, 0, allow.stderr);

  const policy = JSON.parse(run(["policy", "show", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout);
  assert.ok(policy.allow.includes("/bin/zsh -lc printf '%s' \"$TOKEN\" | npx vercel env add FOO production"));
});

function run(args, cwd, env = {}, input = undefined) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input
  });
}
