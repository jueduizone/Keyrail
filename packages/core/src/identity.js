import { readFile } from "node:fs/promises";
import path from "node:path";
import { getGitRemote, normalizeRepoUrl } from "./git.js";
import { KeyrailError } from "./manifest.js";

export async function identifyProject(root, manifest = null) {
  const gitRemote = await getGitRemote(root);
  const packageName = await getPackageName(root);

  return {
    root,
    gitRemote,
    packageName,
    expectedRepo: manifest?.project.repo ?? null,
    repoMatches: manifest ? repoMatches(manifest.project.repo, gitRemote) : null,
    packageMatches: manifest && packageName ? packageName === manifest.project.id : null
  };
}

export function verifyIdentity(identity, manifest) {
  if (manifest.project.repo === "local") {
    return { verified: true, reason: "Manifest uses local repo identity" };
  }

  if (!identity.gitRemote) {
    throw new KeyrailError("IDENTITY_UNVERIFIED", "No git remote is configured for this repository");
  }

  if (!repoMatches(manifest.project.repo, identity.gitRemote)) {
    throw new KeyrailError("IDENTITY_MISMATCH", "Git remote does not match manifest project.repo", {
      expected: manifest.project.repo,
      actual: identity.gitRemote
    });
  }

  return { verified: true, reason: "Git remote matches manifest" };
}

export function repoMatches(expected, actual) {
  if (!expected || expected === "local") return true;
  return normalizeRepoUrl(expected) === normalizeRepoUrl(actual);
}

async function getPackageName(root) {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    return JSON.parse(raw).name ?? null;
  } catch {
    return null;
  }
}
