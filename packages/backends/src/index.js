import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET_FILE = ".keyrail/secrets.local.json";
const GLOBAL_SECRET_FILE = "secrets.global.json";

export function getKeyrailConfigRoot() {
  return process.env.KEYRAIL_HOME ?? path.join(os.homedir(), ".keyrail");
}

export function createSecretBackend(options = {}) {
  const type = options.type ?? "local-file";
  switch (type) {
    case "local-file":
      return new LocalFileSecretBackend(options.root);
    case "env":
      return new EnvSecretBackend();
    default:
      throw new Error(`Unsupported secret backend type: ${type}`);
  }
}

export class LocalFileSecretBackend {
  constructor(root) {
    this.root = root;
    this.path = path.join(root, SECRET_FILE);
  }

  async listReferences(references) {
    const store = await this.readStore();
    return Object.entries(references ?? {}).map(([provider, reference]) => ({
      provider,
      reference,
      envName: envNameForProvider(provider),
      configured: Object.prototype.hasOwnProperty.call(store, reference)
    }));
  }

  async resolveReferences(references) {
    const store = await this.readStore();
    const env = {};
    const resolved = [];
    const missing = [];

    for (const [provider, reference] of Object.entries(references ?? {})) {
      const value = store[reference] ?? process.env[envNameForProvider(provider)] ?? null;
      if (!value) {
        missing.push({ provider, reference });
        continue;
      }

      const envName = envNameForProvider(provider);
      env[envName] = value;
      resolved.push({ provider, reference, envName });
    }

    return { env, resolved, missing };
  }

  async set(reference, value) {
    const store = await this.readStore();
    store[reference] = value;
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  async unset(reference) {
    const store = await this.readStore();
    delete store[reference];
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  async readStore() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
}

export class EnvSecretBackend {
  async listReferences(references) {
    return Object.entries(references ?? {}).map(([provider, reference]) => ({
      provider,
      reference,
      envName: envNameForProvider(provider),
      configured: Boolean(process.env[envNameForProvider(provider)])
    }));
  }

  async resolveReferences(references) {
    const env = {};
    const resolved = [];
    const missing = [];

    for (const [provider, reference] of Object.entries(references ?? {})) {
      const envName = envNameForProvider(provider);
      const value = process.env[envName] ?? null;
      if (!value) {
        missing.push({ provider, reference });
        continue;
      }

      env[envName] = value;
      resolved.push({ provider, reference, envName });
    }

    return { env, resolved, missing };
  }
}

export class GlobalSecretStore {
  constructor(configRoot = getKeyrailConfigRoot()) {
    this.path = path.join(configRoot, GLOBAL_SECRET_FILE);
  }

  async set(reference, value) {
    const store = await this.readStore();
    store[reference] = value;
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  async get(reference) {
    const store = await this.readStore();
    return store[reference] ?? null;
  }

  async unset(reference) {
    const store = await this.readStore();
    delete store[reference];
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  async readStore() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
}

export function envNameForProvider(provider) {
  const known = {
    github: "GITHUB_TOKEN",
    vercel: "VERCEL_TOKEN",
    supabase: "SUPABASE_ACCESS_TOKEN",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    stripe: "STRIPE_API_KEY"
  };

  return known[provider] ?? `KEYRAIL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function redactSecrets(output, values) {
  let redacted = output;
  for (const value of values.filter(Boolean)) {
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}
