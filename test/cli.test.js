import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(cwd, ".keyrail", "secrets.local.json"), JSON.stringify({ "demo-openai": "sk-test-secret" }));

  const result = run(["run", "--", "node", "-e", "console.log(process.env.OPENAI_API_KEY)"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /sk-test-secret/);
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

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8"
  });
}
