import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getGitRemote(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isGitRepository(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function normalizeRepoUrl(value) {
  if (!value) return null;
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}
