import assert from "node:assert/strict";
import test from "node:test";
import { KeyrailError, parseYaml, stringifyYaml, validateManifest } from "@keyrail/core";

test("parses Keyrail manifest YAML subset", () => {
  const parsed = parseYaml(`
project:
  id: acme-web
  name: Acme Web
  repo: git@github.com:acme/web.git
  default_context: staging

contexts:
  staging:
    risk: medium
    require_confirmation: true
    secrets:
      github: acme-github-limited

policy:
  allow:
    - gh issue list
`);

  assert.equal(parsed.project.id, "acme-web");
  assert.equal(parsed.contexts.staging.require_confirmation, true);
  assert.deepEqual(parsed.policy.allow, ["gh issue list"]);
});

test("stringifies nested objects and lists", () => {
  const yaml = stringifyYaml({
    policy: {
      allow: ["gh issue list"],
      deny: ["gh repo delete"]
    }
  });

  assert.match(yaml, /policy:/);
  assert.match(yaml, /allow:\n    - gh issue list/);
});

test("validates manifest default context and risk", () => {
  assert.throws(
    () =>
      validateManifest({
        project: { id: "demo", name: "Demo", repo: "local", defaultContext: "prod" },
        contexts: { local: { name: "local", risk: "low", secrets: {}, requireConfirmation: false } },
        policy: { allow: [], requireConfirm: [], deny: [] }
      }),
    KeyrailError
  );
});
