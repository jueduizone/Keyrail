import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseYaml, stringifyYaml } from "./yaml.js";

export const MANIFEST_FILE = ".agent-context.yaml";
export const LOCK_FILE = ".ctx/lock.yaml";

export async function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);

  while (true) {
    if (await exists(path.join(current, MANIFEST_FILE))) return current;
    if (await exists(path.join(current, ".git"))) return current;

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

export async function loadManifest(startDir = process.cwd()) {
  const root = await findProjectRoot(startDir);
  const manifestPath = path.join(root, MANIFEST_FILE);

  if (!(await exists(manifestPath))) {
    throw new KeyrailError("MANIFEST_NOT_FOUND", `No ${MANIFEST_FILE} found from ${startDir}`);
  }

  const raw = await readFile(manifestPath, "utf8");
  const manifest = normalizeManifest(parseYaml(raw));
  return { root, path: manifestPath, manifest };
}

export async function writeManifest(root, manifest) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  await writeFile(manifestPath, `${stringifyYaml(denormalizeManifest(manifest))}\n`, { mode: 0o600 });
  return manifestPath;
}

export async function readContextLock(root) {
  const lockPath = path.join(root, LOCK_FILE);
  if (!(await exists(lockPath))) return null;

  const raw = await readFile(lockPath, "utf8");
  const lock = parseYaml(raw);
  return {
    project: typeof lock.project === "string" ? lock.project : null,
    context: typeof lock.context === "string" ? lock.context : null
  };
}

export async function writeContextLock(root, lock) {
  const lockPath = path.join(root, LOCK_FILE);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${stringifyYaml({ project: lock.project ?? null, context: lock.context ?? null })}\n`, { mode: 0o600 });
  return lockPath;
}

export async function resolveActiveContextName(root, manifest, requestedContext = null) {
  if (requestedContext) return requestedContext;

  const lock = await readContextLock(root);
  if (lock?.context && manifest.contexts[lock.context]) return lock.context;

  return manifest.project.defaultContext;
}

export function normalizeManifest(input) {
  const project = input.project ?? {};
  const contexts = {};

  for (const [name, context] of Object.entries(input.contexts ?? {})) {
    contexts[name] = {
      name,
      risk: context.risk ?? "low",
      secrets: context.secrets ?? {},
      requireConfirmation: Boolean(context.require_confirmation ?? context.requireConfirmation)
    };
  }

  return {
    project: {
      id: requiredString(project.id, "project.id"),
      name: requiredString(project.name, "project.name"),
      repo: requiredString(project.repo, "project.repo"),
      defaultContext: requiredString(project.default_context ?? project.defaultContext, "project.default_context")
    },
    contexts,
    policy: {
      allow: input.policy?.allow ?? [],
      requireConfirm: input.policy?.require_confirm ?? input.policy?.requireConfirm ?? [],
      deny: input.policy?.deny ?? []
    }
  };
}

export function denormalizeManifest(manifest) {
  const contexts = {};
  for (const [name, context] of Object.entries(manifest.contexts)) {
    contexts[name] = {
      risk: context.risk,
      ...(context.requireConfirmation ? { require_confirmation: true } : {}),
      secrets: context.secrets ?? {}
    };
  }

  return {
    project: {
      id: manifest.project.id,
      name: manifest.project.name,
      repo: manifest.project.repo,
      default_context: manifest.project.defaultContext
    },
    contexts,
    policy: {
      allow: manifest.policy?.allow ?? [],
      require_confirm: manifest.policy?.requireConfirm ?? [],
      deny: manifest.policy?.deny ?? []
    }
  };
}

export function getContext(manifest, contextName = manifest.project.defaultContext) {
  const context = manifest.contexts[contextName];
  if (!context) {
    throw new KeyrailError("CONTEXT_NOT_FOUND", `Context "${contextName}" is not defined`);
  }
  return context;
}

export class KeyrailError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KeyrailError";
    this.code = code;
    this.details = details;
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function requiredString(value, field) {
  if (!value || typeof value !== "string") {
    throw new KeyrailError("INVALID_MANIFEST", `Missing required manifest field ${field}`);
  }
  return value;
}
