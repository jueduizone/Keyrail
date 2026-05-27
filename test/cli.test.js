import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("run dry-run reports injected and missing env vars without executing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-dry-run-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const manifestPath = path.join(cwd, ".agent-context.yaml");
  const markerPath = path.join(cwd, "executed.txt");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest
      .replace("secrets: {}", "secrets:\n      openai: demo-openai\n      stripe: demo-stripe")
      .replace("allow:\n    - gh issue list", "allow:\n    - node -e")
  );
  await mkdir(path.join(cwd, ".keyrail"), { recursive: true });
  await writeFile(path.join(cwd, ".keyrail", "secrets.local.json"), JSON.stringify({ "demo-openai": "DUMMY_DRY_RUN_OPENAI_TOKEN" }));

  const result = run(["run", "--dry-run", "--", "node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would inject:/);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  assert.match(result.stdout, /Missing:/);
  assert.match(result.stdout, /STRIPE_API_KEY/);
  assert.match(result.stdout, /keyrail auth add stripe demo-stripe --value-stdin/);
  assert.doesNotMatch(result.stdout, /DUMMY_DRY_RUN_OPENAI_TOKEN/);
  await assert.rejects(stat(markerPath), { code: "ENOENT" });
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
  assert.match(html, /Vercel Env Sync/);
  assert.match(html, /Policy Repair/);
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
  assert.equal(await realpath(payload.root), await realpath(cwd));
  assert.equal(payload.deployment.project.id, "demo");
  assert.equal(await realpath(payload.deployment.project.root), await realpath(cwd));
  assert.equal(payload.deployment.context.name, "local");
  assert.equal(payload.deployment.services[0].envName, "VERCEL_TOKEN");
  assert.equal(payload.deployment.services[0].state, "missing");
  assert.match(payload.deployment.nextCommand, /keyrail deploy vercel --dry-run/);
  assert.ok(payload.nextSteps.some((step) => step.command === "keyrail deploy vercel --dry-run"));
  assert.ok(payload.nextSteps.some((step) => step.command === "keyrail attach vercel demo-vercel"));

  const human = run(["status"], cwd);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Next steps:/);
  assert.match(human.stdout, /keyrail deploy vercel --dry-run/);

  const detach = run(["detach", "vercel"], cwd);
  assert.equal(detach.status, 0, detach.stderr);
  assert.deepEqual(JSON.parse(run(["status", "--json"], cwd).stdout).services, []);
});

test("attach supports env aliases and reports them in status doctor and dry-run", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-env-alias-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "cloudflare-stream-api-token", "demo-cloudflare", "--env", "CLOUDFLARE_STREAM_API_TOKEN"], cwd).status, 0);
  assert.equal(run(["policy", "allow", "node -e"], cwd).status, 0);

  const manifest = await readFile(path.join(cwd, ".agent-context.yaml"), "utf8");
  assert.match(manifest, /cloudflare-stream-api-token:/);
  assert.match(manifest, /reference: demo-cloudflare/);
  assert.match(manifest, /envName: CLOUDFLARE_STREAM_API_TOKEN/);
  assert.doesNotMatch(manifest, /DUMMY_CLOUDFLARE_TOKEN/);

  const status = run(["status", "--json"], cwd);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.services[0].envName, "CLOUDFLARE_STREAM_API_TOKEN");
  assert.equal(statusPayload.services[0].alias, true);
  assert.equal(statusPayload.context.secrets["cloudflare-stream-api-token"].reference, "demo-cloudflare");

  const humanStatus = run(["status"], cwd);
  assert.equal(humanStatus.status, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /CLOUDFLARE_STREAM_API_TOKEN \(alias\)/);

  const doctor = run(["doctor", "--json"], cwd);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).services[0].envName, "CLOUDFLARE_STREAM_API_TOKEN");

  const dryRun = run(["run", "--dry-run", "--json", "--", "node", "-e", "console.log('no execute')"], cwd);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryRunPayload.missing[0].envName, "CLOUDFLARE_STREAM_API_TOKEN");
  assert.equal(dryRunPayload.missing[0].alias, true);

  const html = await renderUiHtml(cwd);
  assert.match(html, /CLOUDFLARE_STREAM_API_TOKEN/);
  assert.match(html, /Vercel Env Sync/);
  assert.match(html, /keyrail sync vercel-env --dry-run --target development --project demo/);
});

test("run --with injects attached project secrets plus explicit service accounts", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-run-with-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-run-with-home-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(run(["policy", "allow", "node -e"], cwd, { KEYRAIL_HOME: keyrailHome }).status, 0);
  assert.equal(run(["attach", "openai", "demo-openai", "--value", "DUMMY_RUN_WITH_OPENAI"], cwd, { KEYRAIL_HOME: keyrailHome }).status, 0);
  assert.equal(run(["auth", "add", "stripe", "billing", "--value", "DUMMY_RUN_WITH_STRIPE"], cwd, { KEYRAIL_HOME: keyrailHome }).status, 0);

  const dryRun = run(["run", "--with", "stripe,missing-ref", "--dry-run", "--json", "--", "node", "-e", "console.log('no execute')"], cwd, {
    KEYRAIL_HOME: keyrailHome
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const payload = JSON.parse(dryRun.stdout);
  assert.deepEqual(payload.injected.map((secret) => secret.envName).sort(), ["OPENAI_API_KEY", "STRIPE_API_KEY"]);
  assert.equal(payload.missing[0].reference, "missing-ref");
  assert.equal(payload.missing[0].envName, "KEYRAIL_MISSING_REF");
  assert.doesNotMatch(dryRun.stdout, /DUMMY_RUN_WITH_OPENAI|DUMMY_RUN_WITH_STRIPE/);

  const result = run([
    "run",
    "--with",
    "stripe",
    "--",
    "node",
    "-e",
    "console.log([process.env.OPENAI_API_KEY, process.env.STRIPE_API_KEY].join('|'))"
  ], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]\|\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_RUN_WITH_OPENAI|DUMMY_RUN_WITH_STRIPE/);

  const audit = JSON.parse(run(["audit", "list", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout).at(-1);
  assert.deepEqual(audit.injected.map((secret) => secret.envName).sort(), ["OPENAI_API_KEY", "STRIPE_API_KEY"]);
});

test("deploy vercel alias dry-run resolves to vercel deploy with policy and VERCEL_TOKEN", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-deploy-vercel-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_VERCEL_TOKEN"], cwd).status, 0);

  const result = run(["deploy", "vercel", "--dry-run"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run: vercel deploy/);
  assert.match(result.stdout, /VERCEL_TOKEN/);
  assert.doesNotMatch(result.stdout, /DUMMY_VERCEL_TOKEN/);

  const prod = run(["deploy", "vercel", "--prod", "--dry-run"], cwd);
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /CONFIRMATION_REQUIRED/);

  const prodConfirmed = run(["deploy", "vercel", "--prod", "--yes", "--dry-run"], cwd);
  assert.equal(prodConfirmed.status, 0, prodConfirmed.stderr);
  assert.match(prodConfirmed.stdout, /Dry run: vercel deploy --prod --yes/);
});

test("deploy vercel reports exact remediation when VERCEL_TOKEN is missing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-deploy-missing-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-deploy-missing-home-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd, { KEYRAIL_HOME: keyrailHome });

  const unattached = run(["deploy", "vercel", "--dry-run"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.notEqual(unattached.status, 0);
  assert.match(unattached.stderr, /VERCEL_TOKEN is not configured/);
  assert.match(unattached.stderr, /keyrail deploy vercel --dry-run/);
  assert.match(unattached.stderr, /keyrail auth add vercel <name> --value-stdin/);
  assert.match(unattached.stderr, /keyrail attach vercel <name>/);

  assert.equal(run(["attach", "vercel", "demo-vercel"], cwd, { KEYRAIL_HOME: keyrailHome }).status, 0);
  const missingValue = run(["deploy", "vercel", "--dry-run"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.notEqual(missingValue.status, 0);
  assert.match(missingValue.stderr, /VERCEL_TOKEN is not configured/);
  assert.match(missingValue.stderr, /keyrail deploy vercel --dry-run/);
  assert.match(missingValue.stderr, /keyrail attach vercel demo-vercel/);
});

test("status nextSteps include provider-specific setup for common services", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-status-nextsteps-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "github", "demo-github"], cwd).status, 0);
  assert.equal(run(["attach", "supabase", "demo-supabase"], cwd).status, 0);
  assert.equal(run(["attach", "openai", "demo-openai"], cwd).status, 0);

  const status = run(["status", "--json"], cwd);
  assert.equal(status.status, 0, status.stderr);
  const commands = JSON.parse(status.stdout).nextSteps.map((step) => step.command);
  assert.ok(commands.includes("keyrail auth add github demo-github --value-stdin"));
  assert.ok(commands.includes("keyrail auth add supabase demo-supabase --value-stdin"));
  assert.ok(commands.includes("keyrail run --dry-run -- supabase db push"));
  assert.ok(commands.includes("keyrail auth add openai demo-openai --value-stdin"));
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
  assert.equal(payload.mcp.strategy, "mcp-first");
  assert.match(payload.agent.instruction, /Prefer official MCP tools/);
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

test("attach without reference uses the single saved account for that service", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-attach-single-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-attach-single-home-"));

  assert.equal(run(["auth", "add", "github", "jueduizone", "--value", "DUMMY_SINGLE_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const attach = run(["attach", "github"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(attach.status, 0, attach.stderr);
  assert.match(attach.stdout, /Linked github to jueduizone/);

  const status = JSON.parse(run(["status", "--json"], cwd, { KEYRAIL_HOME: keyrailHome }).stdout);
  assert.equal(status.services[0].service, "github");
  assert.equal(status.services[0].reference, "jueduizone");
});

test("attach without reference names default and candidates when multiple accounts exist", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-attach-ambiguous-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-attach-ambiguous-home-"));

  assert.equal(run(["auth", "add", "github", "personal", "--value", "DUMMY_PERSONAL_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);
  assert.equal(run(["auth", "add", "github", "work", "--value", "DUMMY_WORK_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const attach = run(["attach", "github"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.notEqual(attach.status, 0);
  assert.match(attach.stderr, /Multiple github accounts are available/);
  assert.match(attach.stderr, /Default: work/);
  assert.match(attach.stderr, /Candidates: personal, work/);
  assert.match(attach.stderr, /keyrail attach github <reference>/);
});

test("status suggests locally available unattached accounts relevant to the repo", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-status-suggestions-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-status-suggestions-home-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "suggestion-demo" }));

  assert.equal(run(["auth", "add", "github", "jueduizone", "--value", "DUMMY_SUGGEST_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);
  assert.equal(run(["auth", "add", "vercel", "preview", "--value", "DUMMY_SUGGEST_VERCEL_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);
  assert.equal(run(["auth", "add", "stripe", "billing", "--value", "DUMMY_SUGGEST_STRIPE_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const jsonStatus = run(["status", "--json"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  const payload = JSON.parse(jsonStatus.stdout);
  assert.deepEqual(payload.services, []);
  assert.deepEqual(payload.suggestions.map((suggestion) => suggestion.command), [
    "keyrail attach github jueduizone",
    "keyrail attach vercel preview"
  ]);

  const humanStatus = run(["status"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(humanStatus.status, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /Suggestions:/);
  assert.match(humanStatus.stdout, /keyrail attach github jueduizone/);
  assert.match(humanStatus.stdout, /keyrail attach vercel preview/);
  assert.doesNotMatch(humanStatus.stdout, /stripe/);
});

test("doctor reports diagnostics, next steps, and human guidance", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-doctor-cwd-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-doctor-home-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "doctor-demo" }));

  assert.equal(run(["auth", "add", "github", "jueduizone", "--value", "DUMMY_DOCTOR_GITHUB_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);
  assert.equal(run(["auth", "add", "vercel", "preview", "--value", "DUMMY_DOCTOR_VERCEL_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const json = run(["doctor", "--json"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.nextSteps));
  assert.deepEqual(payload.suggestions.map((suggestion) => suggestion.command), [
    "keyrail attach github jueduizone",
    "keyrail attach vercel preview"
  ]);
  assert.ok(payload.nextSteps.some((step) => step.command === "keyrail attach github jueduizone"));
  assert.ok(payload.nextSteps.some((step) => step.command === "keyrail run --dry-run -- <command>"));
  assert.ok(payload.policyGuidance.some((item) => item.command === "vercel deploy" && item.nextCommand.includes("keyrail run --dry-run")));

  const human = run(["doctor"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Keyrail doctor: Doctor Demo/);
  assert.match(human.stdout, /Suggested attachments:/);
  assert.match(human.stdout, /keyrail attach vercel preview/);
  assert.match(human.stdout, /Command policy guidance:/);
  assert.match(human.stdout, /Next steps:/);
});

test("policy denial remediation includes concrete next commands", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-remediation-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const denied = run(["run", "--", "node", "-e", "console.log('blocked')"], cwd);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /POLICY_DENIED/);
  assert.match(denied.stderr, /keyrail doctor/);
  assert.match(denied.stderr, /keyrail policy allow -- node -e/);
  assert.match(denied.stderr, /"nextSteps"/);

  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_POLICY_VERCEL_TOKEN"], cwd).status, 0);
  const prod = run(["deploy", "vercel", "--prod", "--dry-run"], cwd);
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /CONFIRMATION_REQUIRED/);
  assert.match(prod.stderr, /keyrail deploy vercel --prod --yes --dry-run/);
});

test("missing-secret remediation prefers suggested attach commands", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-missing-suggested-"));
  const keyrailHome = await mkdtemp(path.join(os.tmpdir(), "keyrail-missing-suggested-home-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "missing-suggested-demo" }));

  assert.equal(run(["auth", "add", "vercel", "preview", "--value", "DUMMY_PROFILE_VERCEL_TOKEN"], cwd, {
    KEYRAIL_HOME: keyrailHome
  }).status, 0);

  const unattached = run(["deploy", "vercel", "--dry-run"], cwd, { KEYRAIL_HOME: keyrailHome });
  assert.notEqual(unattached.status, 0);
  assert.match(unattached.stderr, /VERCEL_TOKEN is not configured/);
  assert.match(unattached.stderr, /keyrail attach vercel preview/);
  assert.doesNotMatch(unattached.stderr, /--value \.\.\./);
  assert.match(unattached.stderr, /"nextSteps"/);
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

test("GitHub policy failures recommend with/auth/attach remediation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-github-remediation-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "github", "personal"], cwd).status, 0);

  const denied = run(["run", "--dry-run", "--", "git", "push"], cwd);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /POLICY_DENIED/);
  assert.match(denied.stderr, /keyrail with github personal -- git push/);
  assert.match(denied.stderr, /keyrail auth add github personal --value-stdin/);
  assert.match(denied.stderr, /keyrail attach github personal/);
});

test("Supabase missing value remediation uses stdin setup and keyrail run", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-supabase-remediation-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "supabase", "demo-supabase"], cwd).status, 0);

  const result = run(["run", "--dry-run", "--", "supabase", "db", "push"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUPABASE_ACCESS_TOKEN/);
  assert.match(result.stdout, /keyrail auth add supabase demo-supabase --value-stdin/);

  const status = run(["status", "--json"], cwd);
  assert.equal(status.status, 0, status.stderr);
  const commands = JSON.parse(status.stdout).nextSteps.map((step) => step.command);
  assert.ok(commands.includes("keyrail run --dry-run -- supabase db push"));
});

test("README troubleshooting indexes common Keyrail failures", async () => {
  const readme = await readFile(path.resolve("README.md"), "utf8");
  assert.match(readme, /MCP-First Positioning/);
  assert.match(readme, /MCP for service APIs, Keyrail for local project commands and env routing/);
  assert.match(readme, /## Troubleshooting/);
  for (const term of [
    "POLICY_DENIED",
    "CONFIRMATION_REQUIRED",
    "IDENTITY_MISMATCH",
    "SECRET_NOT_FOUND",
    "embedded credentials",
    "GitHub 403"
  ]) {
    assert.match(readme, new RegExp(term));
  }
});

test("agent skill documents current state and private repo bootstrap", async () => {
  const skill = await readFile(path.resolve("agents/keyrail/SKILL.md"), "utf8");
  await stat(path.resolve("docs/agent/README.md"));
  assert.match(skill, /MCP-First Rule/);
  assert.match(skill, /official provider MCP/);
  assert.match(skill, /keyrail status --json/);
  assert.match(skill, /keyrail with github/);
  assert.match(skill, /keyrail auth list --json/);
  assert.match(skill, /Do not ask them to paste a token into chat/);
  assert.match(skill, /Never read, print, or copy raw secret values/);
});

test("sync vercel-env dry-run plans resolved project secrets without exposing values", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-sync-vercel-dry-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_SYNC_VERCEL_TOKEN"], cwd).status, 0);
  assert.equal(run(["attach", "openai", "demo-openai", "--value", "DUMMY_SYNC_OPENAI_TOKEN"], cwd).status, 0);
  assert.equal(run(["attach", "stripe", "demo-stripe"], cwd).status, 0);

  const result = run(["sync", "vercel-env", "--dry-run", "--json", "--target", "preview", "--project", "web-app", "--yes"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DUMMY_SYNC_OPENAI_TOKEN|DUMMY_SYNC_VERCEL_TOKEN/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.envTarget, "preview");
  assert.equal(payload.vercelProject, "web-app");
  assert.deepEqual(payload.wouldSync.map((secret) => secret.envName), ["OPENAI_API_KEY"]);
  assert.deepEqual(payload.missing.map((secret) => secret.envName), ["STRIPE_API_KEY"]);
  assert.equal(payload.auth.configured, true);
  assert.equal(payload.commands[0], "vercel env add OPENAI_API_KEY preview --project web-app --yes");
  assert.deepEqual(payload.synced, []);
});

test("sync vercel-env runs vercel env add with redacted output and audit", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-sync-vercel-real-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "keyrail-vercel-bin-"));
  const logPath = path.join(cwd, "vercel-call.jsonl");
  const fakeVercel = path.join(binDir, "vercel");
  await writeFile(fakeVercel, `#!/usr/bin/env node\nconst { appendFileSync } = require('node:fs');\nconst chunks=[];\nprocess.stdin.on('data', (chunk) => chunks.push(chunk));\nprocess.stdin.on('end', () => {\n  const value=Buffer.concat(chunks).toString('utf8').trim();\n  appendFileSync(process.env.VERCEL_LOG, JSON.stringify({ args: process.argv.slice(2), value, token: process.env.VERCEL_TOKEN }) + '\\n');\n  console.log('added ' + value + ' using ' + process.env.VERCEL_TOKEN);\n});\n`, { mode: 0o700 });
  await chmod(fakeVercel, 0o700);

  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_REAL_VERCEL_TOKEN"], cwd).status, 0);
  assert.equal(run(["attach", "openai", "demo-openai", "--value", "DUMMY_REAL_OPENAI_TOKEN"], cwd).status, 0);

  const result = run(["sync", "vercel-env", "--target", "production", "--project", "demo-web", "--yes"], cwd, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    VERCEL_LOG: logPath
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /DUMMY_REAL_OPENAI_TOKEN|DUMMY_REAL_VERCEL_TOKEN/);
  assert.match(result.stdout, /Synced:/);
  assert.match(result.stdout, /OPENAI_API_KEY/);

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls[0].args, ["env", "add", "OPENAI_API_KEY", "production", "--project", "demo-web", "--yes"]);
  assert.equal(calls[0].value, "DUMMY_REAL_OPENAI_TOKEN");
  assert.equal(calls[0].token, "DUMMY_REAL_VERCEL_TOKEN");

  const audit = JSON.parse(run(["audit", "list", "--json"], cwd).stdout).at(-1);
  assert.equal(audit.decision, "allowed");
  assert.deepEqual(audit.synced, ["OPENAI_API_KEY"]);
  assert.deepEqual(audit.missingEnvNames, []);
});

test("sync vercel-env defaults local context to Vercel development target", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-sync-vercel-default-target-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_DEFAULT_TARGET_VERCEL_TOKEN"], cwd).status, 0);
  assert.equal(run(["attach", "openai", "demo-openai", "--value", "DUMMY_DEFAULT_TARGET_OPENAI_TOKEN"], cwd).status, 0);

  const result = run(["sync", "vercel-env", "--dry-run", "--json"], cwd);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.context.name, "local");
  assert.equal(payload.envTarget, "development");
  assert.equal(payload.commands[0], "vercel env add OPENAI_API_KEY development --project demo");
  assert.doesNotMatch(result.stdout, /DUMMY_DEFAULT_TARGET_OPENAI_TOKEN|DUMMY_DEFAULT_TARGET_VERCEL_TOKEN/);
});

test("sync vercel-env uses existing Vercel token remediation when token is missing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-sync-vercel-missing-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "openai", "demo-openai", "--value", "DUMMY_MISSING_TOKEN_OPENAI"], cwd).status, 0);

  const result = run(["sync", "vercel-env"], cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VERCEL_TOKEN is not configured/);
  assert.match(result.stderr, /keyrail auth add vercel <name> --value-stdin/);
  assert.doesNotMatch(result.stderr, /DUMMY_MISSING_TOKEN_OPENAI/);
});

test("status and UI expose Vercel env sync mappings and policy repair guidance", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-ui-p2-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["attach", "vercel", "demo-vercel", "--value", "DUMMY_UI_VERCEL_TOKEN"], cwd).status, 0);
  assert.equal(run(["attach", "cloudflare-stream-api-token", "demo-cloudflare", "--env", "CLOUDFLARE_STREAM_API_TOKEN"], cwd).status, 0);

  const denied = run(["run", "--dry-run", "--", "vercel", "env", "add", "FOO", "preview"], cwd);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /keyrail policy allow-last/);
  assert.match(denied.stderr, /keyrail policy preset vercel/);

  const status = run(["status", "--json"], cwd);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.vercelEnvSync.auth.status, "ready");
  assert.deepEqual(payload.vercelEnvSync.mappings.map((item) => item.envName), ["CLOUDFLARE_STREAM_API_TOKEN"]);
  assert.equal(payload.vercelEnvSync.mappings[0].alias, true);
  assert.equal(payload.policyRepair.command, "vercel env add FOO preview");
  assert.ok(payload.policyRepair.nextSteps.some((step) => step.command === "keyrail policy preset vercel"));

  const human = run(["status"], cwd);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Vercel env sync:/);
  assert.match(human.stdout, /CLOUDFLARE_STREAM_API_TOKEN \(alias\)/);
  assert.match(human.stdout, /Policy repair:/);

  const html = await renderUiHtml(cwd);
  assert.match(html, /Policy Repair/);
  assert.match(html, /keyrail policy preset vercel/);
  assert.match(html, /CLOUDFLARE_STREAM_API_TOKEN/);
  assert.doesNotMatch(html, /DUMMY_UI_VERCEL_TOKEN/);
});

test("policy presets can be listed shown applied idempotently", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-preset-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const listed = run(["policy", "preset", "--json"], cwd);
  assert.equal(listed.status, 0, listed.stderr);
  const presets = JSON.parse(listed.stdout);
  assert.ok(presets.vercel.allow.includes("vercel env add"));
  assert.ok(presets["cloudflare-api"].deny.includes("wrangler delete"));

  const shown = run(["policy", "preset", "vercel", "--show", "--json"], cwd);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).name, "vercel");

  const applied = run(["policy", "preset", "vercel", "--json"], cwd);
  assert.equal(applied.status, 0, applied.stderr);
  const payload = JSON.parse(applied.stdout);
  assert.ok(payload.added.allow.includes("vercel env add"));

  const appliedAgain = run(["policy", "preset", "vercel", "--json"], cwd);
  assert.equal(appliedAgain.status, 0, appliedAgain.stderr);
  assert.deepEqual(JSON.parse(appliedAgain.stdout).added.allow, []);

  const policy = JSON.parse(run(["policy", "show", "--json"], cwd).stdout);
  assert.ok(policy.allow.includes("keyrail sync vercel-env"));
  assert.ok(policy.requireConfirm.includes("keyrail sync vercel-env --target production"));
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

test("policy allow-last promotes the last denied audit command", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-allow-last-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);

  const denied = run(["run", "--", "node", "-e", "console.log('blocked')"], cwd);
  assert.notEqual(denied.status, 0);

  const allowLast = run(["policy", "allow-last", "--json"], cwd);
  assert.equal(allowLast.status, 0, allowLast.stderr);
  const payload = JSON.parse(allowLast.stdout);
  assert.equal(payload.command, "node -e console.log('blocked')");
  assert.equal(payload.list, "allow");

  const policy = JSON.parse(run(["policy", "show", "--json"], cwd).stdout);
  assert.ok(policy.allow.includes("node -e console.log('blocked')"));
});

test("policy allow-last refuses to override explicit deny rules", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keyrail-policy-allow-last-deny-"));
  run(["init", "--id", "demo", "--repo", "local"], cwd);
  assert.equal(run(["policy", "deny", "node -e"], cwd).status, 0);

  const denied = run(["run", "--", "node", "-e", "console.log('blocked')"], cwd);
  assert.notEqual(denied.status, 0);

  const allowLast = run(["policy", "allow-last"], cwd);
  assert.notEqual(allowLast.status, 0);
  assert.match(allowLast.stderr, /explicit deny rule/);

  const policy = JSON.parse(run(["policy", "show", "--json"], cwd).stdout);
  assert.ok(!policy.allow.includes("node -e console.log('blocked')"));
});

function run(args, cwd, env = {}, input = undefined) {
  const homeKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, KEYRAIL_HOME: path.join(os.tmpdir(), `keyrail-test-home-${homeKey}`), ...env },
    input
  });
}
