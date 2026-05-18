import assert from "node:assert/strict";
import test from "node:test";
import { parseYaml, stringifyYaml } from "@keyrail/core";

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
