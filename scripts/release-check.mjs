#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "keyrail-release-"));
const packDir = path.join(tmpRoot, "pack");
const installDir = path.join(tmpRoot, "install");
const cleanEnv = {
  ...process.env,
  HOME: path.join(tmpRoot, "home"),
  KEYRAIL_HOME: path.join(tmpRoot, "keyrail-home"),
  npm_config_cache: path.join(tmpRoot, "npm-cache"),
  npm_config_loglevel: "warn"
};

const workspaces = ["@keyrail/core", "@keyrail/policy", "@keyrail/backends", "@keyrail/cli"];
const requiredCliEntries = [
  "package/bin/keyrail.js",
  "package/src/cli.js",
  "package/package.json",
  "package/README.md"
];
const forbiddenPatterns = [
  /^package\/\.env(?:\.|$)/,
  /^package\/\.keyrail\//,
  /^package\/\.ctx\//,
  /^package\/secrets(?:\.|$)/i,
  /secrets\.local\.json$/i,
  /secrets\.global\.json$/i,
  /projects\.json$/i,
  /profiles\.json$/i,
  /audit\.jsonl$/i,
  /npm-debug\.log$/i
];

try {
  run("npm", ["run", "check"], { env: cleanEnv });
  run("npm", ["run", "smoke"], { env: cleanEnv });
  run("npm", ["pack", "--dry-run", "--workspace", "@keyrail/cli"], { env: cleanEnv });

  await mkdirp(packDir);
  const tarballs = [];
  for (const workspace of workspaces) {
    const packed = run("npm", ["pack", "--workspace", workspace, "--pack-destination", packDir], { env: cleanEnv });
    const tarballName = packed.stdout.trim().split(/\r?\n/).at(-1);
    assert.match(tarballName, /^keyrail-[a-z]+-\d+\.\d+\.\d+\.tgz$/);
    const tarballPath = path.join(packDir, tarballName);
    await stat(tarballPath);
    tarballs.push(tarballPath);

    const list = run("tar", ["-tzf", tarballPath]).stdout.trim().split(/\r?\n/).filter(Boolean);
    for (const entry of list) {
      assert.equal(forbiddenPatterns.find((pattern) => pattern.test(entry)), undefined, `Package tarball includes local state or secret-like file: ${entry}`);
    }
    if (workspace === "@keyrail/cli") {
      for (const entry of requiredCliEntries) {
        assert.ok(list.includes(entry), `CLI tarball is missing ${entry}`);
      }
    } else {
      assert.ok(list.includes("package/src/index.js"), `${workspace} tarball is missing package/src/index.js`);
      assert.ok(list.includes("package/package.json"), `${workspace} tarball is missing package/package.json`);
    }
  }

  await mkdirp(installDir);
  await writeFile(path.join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
    cwd: installDir,
    env: cleanEnv
  });
  const help = run(process.execPath, [path.join(installDir, "node_modules/@keyrail/cli/bin/keyrail.js"), "help"], {
    cwd: installDir,
    env: cleanEnv
  });
  assert.match(help.stdout, /Keyrail/);
  assert.match(help.stdout, /Usage:/);

  console.log("release check ok");
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, [
    `${command} ${args.join(" ")} failed with ${result.status}`,
    result.error?.stack ?? result.error?.message,
    result.stdout.trim(),
    result.stderr.trim()
  ].filter(Boolean).join("\n"));
  return result;
}

async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}
