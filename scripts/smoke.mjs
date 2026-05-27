#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../packages/cli/src/cli.js";

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "keyrail-smoke-"));
const cwd = path.join(tmpRoot, "project");
const keyrailHome = path.join(tmpRoot, "home");
const env = {
  ...process.env,
  KEYRAIL_HOME: keyrailHome,
  HOME: path.join(tmpRoot, "os-home")
};

await mkdir(cwd, { recursive: true });
await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "keyrail-smoke-project" }));

const steps = [];

step("auth add with dummy values", async () => {
  await ok(["auth", "add", "github", "personal", "--value", "DUMMY_SMOKE_GITHUB_TOKEN"]);
  await ok(["auth", "add", "vercel", "preview", "--value", "DUMMY_SMOKE_VERCEL_TOKEN"]);
  await ok(["auth", "add", "openai", "demo-openai", "--value", "DUMMY_SMOKE_OPENAI_TOKEN"]);
});

step("attach services", async () => {
  await ok(["attach", "github", "personal"]);
  await ok(["attach", "vercel", "preview"]);
  await ok(["attach", "openai", "demo-openai"]);
  await ok(["attach", "stripe", "demo-stripe"]);
});

step("status --json exposes nextSteps", async () => {
  const payload = await json(["status", "--json"]);
  assert.equal(payload.project.id, "keyrail-smoke-project");
  assert.ok(Array.isArray(payload.nextSteps));
  assert.ok(payload.nextSteps.some((item) => item.command === "keyrail deploy vercel --dry-run"));
  assert.ok(payload.services.some((service) => service.service === "stripe" && service.state === "missing"));
});

step("doctor --json exposes checks and nextSteps", async () => {
  const payload = await json(["doctor", "--json"]);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.some((check) => check.name === "services" && check.status === "warn"));
  assert.ok(payload.nextSteps.some((item) => item.command === "keyrail auth add stripe demo-stripe --value-stdin"));
});

step("run --dry-run reports injected and missing services", async () => {
  await ok(["policy", "allow", "--", "node", "-e"]);
  const result = await ok(["run", "--dry-run", "--", "node", "-e", "console.log('not executed')"]);
  assert.match(result.stdout, /Would inject:/);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  assert.match(result.stdout, /GITHUB_TOKEN/);
  assert.match(result.stdout, /Missing:/);
  assert.match(result.stdout, /STRIPE_API_KEY/);
  assertNoDummyValues(result);
});

step("deploy vercel --dry-run remediation for missing value", async () => {
  await ok(["detach", "vercel", "--delete-value"]);
  await ok(["attach", "vercel", "missing-vercel"]);
  const result = await fails(["deploy", "vercel", "--dry-run"]);
  assert.match(result.stderr, /SECRET_NOT_FOUND/);
  assert.match(result.stderr, /VERCEL_TOKEN is not configured/);
  assert.match(result.stderr, /keyrail deploy vercel --dry-run/);
  assert.match(result.stderr, /keyrail auth add vercel missing-vercel --value-stdin/);
  assertNoDummyValues(result);
});

step("GitHub policy denial remediation", async () => {
  const result = await fails(["run", "--dry-run", "--", "git", "push"]);
  assert.match(result.stderr, /POLICY_DENIED/);
  assert.match(result.stderr, /keyrail with github personal -- git push/);
  assert.match(result.stderr, /keyrail auth add github personal --value-stdin/);
  assert.match(result.stderr, /keyrail attach github personal/);
});

step("Supabase dry-run missing-value remediation", async () => {
  await ok(["attach", "supabase", "demo-supabase"]);
  const result = await ok(["run", "--dry-run", "--", "supabase", "db", "push"]);
  assert.match(result.stdout, /SUPABASE_ACCESS_TOKEN/);
  assert.match(result.stdout, /keyrail auth add supabase demo-supabase --value-stdin/);
});

step("no local project state was written", async () => {
  await assert.rejects(stat(path.join(cwd, ".agent-context.yaml")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(cwd, ".ctx")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(cwd, ".keyrail")), { code: "ENOENT" });
  const profile = await readFile(path.join(keyrailHome, "profiles.json"), "utf8");
  assert.match(profile, /personal/);
});

for (const item of steps) {
  await item.run();
  console.log(`smoke ok: ${item.name}`);
}

function step(name, run) {
  steps.push({ name, run });
}

function run(args, input = undefined) {
  assert.equal(input, undefined, "The in-process smoke harness does not use stdin");
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  let stderr = "";

  process.chdir(cwd);
  process.env = env;
  process.exitCode = undefined;
  console.log = (...items) => {
    stdout += `${items.join(" ")}\n`;
  };
  console.error = (...items) => {
    stderr += `${items.join(" ")}\n`;
  };

  return Promise.resolve()
    .then(() => main(args))
    .then(() => ({
      status: process.exitCode ?? 0,
      stdout,
      stderr
    }))
    .catch((error) => {
      const code = error.code ? `${error.code}: ` : "";
      stderr += `keyrail: ${code}${error.message}\n`;
      if (error.details && Object.keys(error.details).length > 0) {
        stderr += `${JSON.stringify(error.details, null, 2)}\n`;
      }
      return {
        status: 1,
        stdout,
        stderr,
        error
      };
    })
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
      process.env = originalEnv;
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    });
}

async function ok(args, input = undefined) {
  const result = await run(args, input);
  assert.equal(result.status, 0, commandFailure(args, result));
  return result;
}

async function fails(args, input = undefined) {
  const result = await run(args, input);
  assert.notEqual(result.status, 0, `Expected failure for keyrail ${args.join(" ")}`);
  return result;
}

async function json(args) {
  const result = await ok(args);
  return JSON.parse(result.stdout);
}

function commandFailure(args, result) {
  return [
    `keyrail ${args.join(" ")} failed with ${result.status}`,
    result.error?.stack ?? result.error?.message,
    result.stdout.trim(),
    result.stderr.trim()
  ].filter(Boolean).join("\n");
}

function assertNoDummyValues(result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(combined, /DUMMY_SMOKE_[A-Z_]+/);
}
