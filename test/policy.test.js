import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "@keyrail/policy";
import { createSecretBackend } from "@keyrail/backends";

const context = { name: "staging", risk: "medium", requireConfirmation: false };
const policy = {
  allow: ["gh issue list", "vercel deploy"],
  requireConfirm: ["vercel deploy --prod"],
  deny: ["gh repo delete"]
};

test("allows prefix-matched commands", () => {
  const decision = evaluatePolicy({
    command: ["gh", "issue", "list", "--limit", "5"],
    context,
    policy
  });

  assert.equal(decision.allowed, true);
});

test("denies explicit deny entries before allow entries", () => {
  const decision = evaluatePolicy({
    command: ["gh", "repo", "delete"],
    context,
    policy
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /denied/);
});

test("requires confirmation for protected commands", () => {
  const decision = evaluatePolicy({
    command: ["vercel", "deploy", "--prod"],
    context,
    policy
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresConfirmation, true);
});

test("blocks shell control tokens", () => {
  const decision = evaluatePolicy({
    command: ["gh", "issue", "list", "&&", "gh", "repo", "delete"],
    context,
    policy
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /Shell control/);
});

test("defaults to local-file secret backend and supports env backend", () => {
  assert.equal(createSecretBackend({ root: process.cwd() }).constructor.name, "LocalFileSecretBackend");
  assert.equal(createSecretBackend({ type: "env" }).constructor.name, "EnvSecretBackend");
});
