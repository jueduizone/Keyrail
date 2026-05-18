import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getStateForUi, normalizeGithubRepoUrl, renderUiHtml } from "../packages/cli/src/cli.js";

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

test("github clone urls normalize without embedding tokens", () => {
  assert.equal(normalizeGithubRepoUrl("acme/private-repo"), "https://github.com/acme/private-repo.git");
  assert.equal(normalizeGithubRepoUrl("acme/private-repo.git"), "https://github.com/acme/private-repo.git");
  assert.equal(normalizeGithubRepoUrl("git@github.com:acme/private-repo.git"), "git@github.com:acme/private-repo.git");
  assert.equal(normalizeGithubRepoUrl("https://github.com/acme/private-repo.git"), "https://github.com/acme/private-repo.git");
});

test("agent skill documents current state and private repo bootstrap", async () => {
  const skill = await readFile(path.resolve("agents/keyrail/SKILL.md"), "utf8");
  await stat(path.resolve("docs/agent/README.md"));
  assert.match(skill, /keyrail current --json/);
  assert.match(skill, /keyrail clone github/);
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

function run(args, cwd, env = {}, input = undefined) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input
  });
}
