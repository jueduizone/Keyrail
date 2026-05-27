import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GlobalSecretStore, createSecretBackend, envNameForProvider, getKeyrailConfigRoot, redactSecrets } from "@keyrail/backends";
import {
  KeyrailError,
  MANIFEST_FILE,
  denormalizeManifest,
  findProjectRoot,
  getContext,
  identifyProject,
  loadManifest,
  normalizeManifest,
  removeContext,
  removeSecretReference,
  resolveActiveContextName,
  setSecretAttachment,
  setSecretReference,
  upsertContext,
  validateManifest,
  writeContextLock,
  verifyIdentity,
  writeManifest
} from "@keyrail/core";
import { evaluatePolicy, normalizeCommand } from "@keyrail/policy";

const POLICY_PRESETS = {
  vercel: {
    description: "Vercel deploys and environment sync inspection.",
    allow: ["vercel deploy", "vercel env ls", "vercel env pull", "vercel env add", "keyrail sync vercel-env"],
    requireConfirm: ["vercel deploy --prod", "keyrail sync vercel-env --target production"],
    deny: []
  },
  "cloudflare-api": {
    description: "Cloudflare read/write API calls that avoid destructive zone deletion by default.",
    allow: ["wrangler whoami", "wrangler deploy", "wrangler pages deploy", "wrangler kv namespace list", "curl https://api.cloudflare.com/client/v4"],
    requireConfirm: ["wrangler secret put", "wrangler kv key put", "wrangler d1 execute"],
    deny: ["wrangler delete", "wrangler pages project delete", "wrangler kv namespace delete", "wrangler d1 delete"]
  },
  "github-read": {
    description: "Read-only GitHub CLI and git fetch/clone workflows.",
    allow: ["gh issue list", "gh issue view", "gh pr list", "gh pr view", "gh repo view", "git fetch", "git pull", "git clone"],
    requireConfirm: [],
    deny: ["gh repo delete", "gh repo archive", "git push --force"]
  }
};

export async function main(argv) {
  const { command, args, flags, passthrough } = parseArgs(argv);

  switch (command) {
    case "init":
      return initCommand(flags);
    case "bind":
      return bindCommand(flags);
    case "current":
      return currentCommand(flags);
    case "status":
      return currentCommand(flags);
    case "identify":
      return identifyCommand(flags);
    case "doctor":
      return doctorCommand(flags);
    case "run":
      return runCommand(args, flags, passthrough);
    case "deploy":
      return deployCommand(args, flags);
    case "handoff":
      return handoffCommand(flags);
    case "link":
    case "attach":
      return linkCommand(args, flags);
    case "unlink":
    case "detach":
      return unlinkCommand(args, flags);
    case "projects":
      return projectsCommand(args, flags);
    case "profile":
      return profileCommand(args, flags);
    case "use":
      return useCommand(args, flags, passthrough);
    case "auth":
      return authCommand(args, flags);
    case "with":
      return withCommand(args, flags, passthrough);
    case "secrets":
      return secretsCommand(args, flags);
    case "context":
      return contextCommand(args, flags);
    case "policy":
      return policyCommand(args, flags, passthrough);
    case "sync":
      return syncCommand(args, flags);
    case "audit":
      return auditCommand(args, flags);
    case "ui":
    case "serve":
      return serveCommand(flags);
    case "help":
    case undefined:
      return printHelp();
    default:
      throw new KeyrailError("UNKNOWN_COMMAND", `Unknown command "${command}"`);
  }
}

async function initCommand(flags) {
  const root = process.cwd();
  const repo = flags.repo ?? "local";
  const id = flags.id ?? path.basename(root);
  const name = flags.name ?? titleize(id);
  const defaultContext = flags.context ?? "local";
  const manifest = {
    project: { id, name, repo, defaultContext },
    contexts: {
      [defaultContext]: {
        name: defaultContext,
        risk: "low",
        secrets: {},
        requireConfirmation: false
      }
    },
    policy: {
      allow: ["gh issue list", "vercel deploy", "supabase db push"],
      requireConfirm: ["vercel deploy --prod", "supabase db reset"],
      deny: ["gh repo delete"]
    }
  };

  const manifestPath = await writeManifest(root, manifest);
  await ensureLocalKeyrailGitignore(root);
  await writeContextLock(root, { project: id, context: defaultContext });
  console.log(`Created ${manifestPath}`);
}

async function bindCommand(flags) {
  const loaded = await loadProjectState(process.cwd());
  const identity = await identifyProject(loaded.root, loaded.manifest);
  verifyIdentity(identity, loaded.manifest);
  const contextName = flags.context ?? loaded.manifest.project.defaultContext;
  getContext(loaded.manifest, contextName);
  await writeActiveContext(loaded, contextName);
  console.log(`Bound ${loaded.manifest.project.id} to ${contextName}`);
}

async function currentCommand(flags) {
  const state = await getVerifiedState(flags.context);
  const payload = await buildStatusPayload(state, flags);

  if (flags.json) return printJson(payload);
  printDeploymentStatus(payload);
}

async function identifyCommand(flags) {
  let loaded = null;
  try {
    loaded = await loadProjectState(process.cwd());
  } catch (error) {
    if (error.code !== "MANIFEST_NOT_FOUND") throw error;
  }

  const root = loaded?.root ?? process.cwd();
  const identity = await identifyProject(root, loaded?.manifest ?? null);
  if (flags.json) return printJson(identity);
  console.log(`Root: ${identity.root}`);
  console.log(`Git remote: ${identity.gitRemote ?? "none"}`);
  console.log(`Package: ${identity.packageName ?? "none"}`);
  if (identity.expectedRepo) console.log(`Expected repo: ${identity.expectedRepo}`);
  if (identity.repoMatches !== null) console.log(`Repo matches: ${identity.repoMatches ? "yes" : "no"}`);
}

async function doctorCommand(flags) {
  const loaded = await loadProjectState(process.cwd());
  const contextName = await resolveProjectContextName(loaded, flags.context);
  const context = getContext(loaded.manifest, contextName);
  const identity = await identifyProject(loaded.root, loaded.manifest);
  const verification = verifyProjectIdentity(identity, loaded.manifest);
  const state = { ...loaded, context, identity, verification };
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  const services = secrets.map((secret) => ({
    service: secret.provider,
    reference: secret.reference,
    envName: secret.envName,
    alias: secret.alias,
    configured: secret.configured,
    state: secret.configured ? "configured" : "missing"
  }));
  const missing = secrets.filter((secret) => !secret.configured);
  const suggestions = await buildStatusSuggestions(state, services);
  const nextSteps = buildDoctorNextSteps({ state, verification, services, missing, suggestions });
  const policyGuidance = buildPolicyGuidance(state);
  const checks = [];

  checks.push(pass("project", state.source === "user" ? "User-level project routing is valid" : `${MANIFEST_FILE} is valid`));
  checks.push(verification.verified ? pass("identity", verification.reason) : fail("identity", verification.reason));

  const remoteCredential = embeddedCredentialRemote(identity.gitRemote);
  if (remoteCredential) {
    checks.push(warn("remote", `Git remote contains embedded credentials for ${remoteCredential.host}`));
  } else if (identity.gitRemote) {
    checks.push(pass("remote", "Git remote does not contain embedded credentials"));
  } else {
    checks.push(warn("remote", "No git remote is configured"));
  }

  if (!services.length) {
    checks.push(warn("services", "No services are attached to this project context"));
  } else if (missing.length > 0) {
    checks.push(warn("services", `${missing.length} linked service(s) are missing local values`));
  } else {
    checks.push(pass("services", "All linked services are configured locally"));
  }

  if (suggestions.length > 0) {
    checks.push(warn("suggestions", `${suggestions.length} local account(s) look relevant but are not attached`));
  }

  const ok = !checks.some((check) => check.status === "fail");
  const payload = {
    ok,
    checks,
    project: state.manifest.project,
    root: state.root,
    context: state.context,
    identity: state.identity,
    verification: state.verification,
    services,
    suggestions,
    policyGuidance,
    nextSteps
  };
  if (flags.json) return printJson(payload);
  printDoctor(payload);
  if (!ok) process.exitCode = 1;
}

async function runCommand(args, flags, passthrough) {
  const command = passthrough.length > 0 ? passthrough : args;
  const state = await getVerifiedState(flags.context);
  const confirmed = await resolveConfirmation(flags, state);
  const decision = evaluatePolicy({
    command,
    context: state.context,
    policy: state.manifest.policy,
    confirmed
  });

  if (!decision.allowed) {
    const remediation = await remediationForPolicyDecision(decision, command, state, flags);
    await appendAudit(state, {
      at: new Date().toISOString(),
      project: state.manifest.project.id,
      context: state.context.name,
      command: normalizeCommand(command),
      decision: decision.requiresConfirmation ? "confirmation_required" : "denied",
      reason: decision.reason,
      injected: [],
      missing: []
    });
    throw new KeyrailError(
      decision.requiresConfirmation ? "CONFIRMATION_REQUIRED" : "POLICY_DENIED",
      `${decision.reason}. ${remediation.message}`,
      { nextSteps: remediation.nextSteps }
    );
  }

  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const requestedReferences = await buildRunReferences(state, flags);
  const secrets = await backend.resolveReferences(requestedReferences);
  const auditBase = {
    at: new Date().toISOString(),
    project: state.manifest.project.id,
    context: state.context.name,
    command: normalizeCommand(command),
    injected: secrets.resolved.map(formatSecretForOutput),
    missing: secrets.missing.map(formatSecretForOutput)
  };

  if (flags.dryRun) {
    const payload = {
      project: {
        id: state.manifest.project.id,
        name: state.manifest.project.name,
        root: state.root
      },
      context: {
        name: state.context.name,
        risk: state.context.risk,
        requireConfirmation: state.context.requireConfirmation
      },
      command: normalizeCommand(command),
      policy: {
        allowed: true,
        reason: decision.reason ?? "allowed"
      },
      injected: auditBase.injected,
      missing: auditBase.missing,
      wouldExecute: false
    };
    await appendAudit(state, { ...auditBase, decision: "dry_run" });
    if (flags.json) return printJson(payload);
    printDryRun(payload);
    return;
  }

  if (secrets.missing.length > 0) {
    await appendAudit(state, { ...auditBase, decision: "missing_secrets" });
    throw await missingSecretsError(secrets.missing, state);
  }

  const childEnv = { ...process.env, ...secrets.env };
  const secretValues = Object.values(secrets.env);
  const audit = { ...auditBase, decision: "allowed" };

  console.error(`keyrail: running ${audit.command} in ${audit.project}/${audit.context}`);

  const exitCode = await spawnRedacted(command, childEnv, secretValues);
  await appendAudit(state, audit);
  process.exitCode = exitCode;
}

async function deployCommand(args, flags) {
  const target = args[0];
  if (target !== "vercel") {
    throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail deploy vercel [--prod] [--yes]");
  }

  const command = ["vercel", "deploy"];
  if (flags.prod) command.push("--prod");
  if (flags.yes) command.push("--yes");

  const state = await getVerifiedState(flags.context);
  const reference = state.context.secrets.vercel;
  if (!reference) {
    const remediation = await remediationForUnattachedSecret("vercel", state);
    throw new KeyrailError(
      "SECRET_NOT_FOUND",
      `VERCEL_TOKEN is not configured for this project. ${remediation.message}`,
      { nextSteps: remediation.nextSteps }
    );
  }

  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await backend.resolveReferences({ vercel: reference });
  if (secrets.missing.length > 0) throw await missingSecretsError(secrets.missing, state);

  return runCommand(command, flags, []);
}

async function handoffCommand(flags) {
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  const payload = {
    project: state.manifest.project,
    context: {
      name: state.context.name,
      risk: state.context.risk,
      requireConfirmation: state.context.requireConfirmation
    },
    root: state.root,
    identity: {
      gitRemote: state.identity.gitRemote,
      verified: true,
      reason: state.verification.reason
    },
    secrets: secrets.map(({ provider, reference, configured }) => ({ provider, reference, configured })),
    policy: state.manifest.policy
  };

  if (flags.json) return printJson(payload);
  console.log(`# Keyrail handoff`);
  console.log(`Project: ${payload.project.name} (${payload.project.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context.name} (${payload.context.risk})`);
  console.log(`Identity: ${payload.identity.reason}`);
  printSecretReferences(payload.secrets);
}

async function linkCommand(args, flags) {
  const service = args[0] ?? flags.service;
  if (!service) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail attach <service> <name> [--value <secret>]");
  const reference = await resolveAttachReference(service, args[1] ?? flags.reference);

  const loaded = await loadProjectState(process.cwd());
  const contextName = await resolveProjectContextName(loaded, flags.context);
  const attachment = flags.env ? { reference, envName: flags.env } : reference;
  setSecretAttachment(loaded.manifest, contextName, service, attachment);
  await writeProjectState(loaded);

  if (flags.value !== undefined) {
    if (loaded.source === "user") await new GlobalSecretStore().set(reference, flags.value);
    else {
      const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: loaded.root });
      await backend.set(reference, flags.value);
    }
  }

  console.log(`Linked ${service} to ${reference}${flags.env ? ` as ${flags.env}` : ""} for ${loaded.manifest.project.id}/${contextName}`);
}

async function resolveAttachReference(service, requestedReference) {
  if (requestedReference) return requestedReference;

  const profile = await readProfile();
  const candidates = Object.keys(profile.accounts[service] ?? {}).sort();
  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    const defaultReference = profile.services[service]?.reference;
    const defaultText = defaultReference ? ` Default: ${defaultReference}.` : "";
    throw new KeyrailError(
      "AMBIGUOUS_ACCOUNT",
      `Multiple ${service} accounts are available.${defaultText} Candidates: ${candidates.join(", ")}. Run keyrail attach ${service} <reference>.`
    );
  }

  throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail attach <service> <name> [--value <secret>]");
}

async function unlinkCommand(args, flags) {
  const service = args[0] ?? flags.service;
  if (!service) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail detach <service>");

  const loaded = await loadProjectState(process.cwd());
  const contextName = await resolveProjectContextName(loaded, flags.context);
  const reference = referenceNameForAttachment(getContext(loaded.manifest, contextName).secrets[service]);
  removeSecretReference(loaded.manifest, contextName, service);
  await writeProjectState(loaded);

  if (flags.deleteValue && reference) {
    if (loaded.source === "user") await new GlobalSecretStore().unset(reference);
    else {
      const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: loaded.root });
      if (typeof backend.unset === "function") await backend.unset(reference);
    }
  }

  console.log(`Unlinked ${service} from ${loaded.manifest.project.id}/${contextName}`);
}

async function projectsCommand(args, flags) {
  const state = await getVerifiedState(flags.context);
  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const services = await backend.listReferences(state.context.secrets);
  const payload = {
    active: true,
    id: state.manifest.project.id,
    name: state.manifest.project.name,
    root: state.root,
    context: state.context.name,
    services: services.map((service) => ({
      service: service.provider,
      reference: service.reference,
      envName: service.envName,
      alias: service.alias,
      configured: service.configured
    }))
  };

  if (flags.json) return printJson([payload]);
  console.log(`${payload.name} (${payload.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context}`);
  printServiceLinks(payload.services);
}

async function profileCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const profilePath = getProfilePath();

  if (subcommand === "list") {
    const profile = await readProfile();
    if (flags.json) return printJson(profile);
    if (!Object.keys(profile.accounts).length) {
      console.log("Accounts: none");
      return;
    }
    console.log("Accounts:");
    for (const [service, accounts] of Object.entries(profile.accounts)) {
      const defaultReference = profile.services[service]?.reference;
      for (const reference of Object.keys(accounts)) {
        console.log(`- ${service}: ${reference}${reference === defaultReference ? " (default)" : ""}`);
      }
    }
    return;
  }

  if (subcommand === "set") {
    const service = args[1] ?? flags.service;
    const reference = args[2] ?? flags.reference;
    const value = flags.value ?? (flags.valueStdin ? await readStdin({ allowEmpty: flags.allowEmpty }) : null);
    if (!service || !reference) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail profile set <service> <reference> [--value <secret>|--value-stdin]");
    const profile = await readProfile();
    profile.services[service] = { reference };
    profile.accounts[service] = profile.accounts[service] ?? {};
    profile.accounts[service][reference] = { reference };
    await writeProfile(profilePath, profile);
    if (value !== null) await new GlobalSecretStore().set(reference, value);
    console.log(`Saved ${service} account ${reference}`);
    return;
  }

  if (subcommand === "unset") {
    const service = args[1] ?? flags.service;
    const requestedReference = args[2] ?? flags.reference ?? flags.name;
    if (!service) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail auth remove <service> [name]");
    const profile = await readProfile();
    const reference = requestedReference ?? profile.services[service]?.reference;
    if (requestedReference) {
      delete profile.accounts[service]?.[requestedReference];
      if (profile.accounts[service] && !Object.keys(profile.accounts[service]).length) delete profile.accounts[service];
      if (profile.services[service]?.reference === requestedReference) {
        const nextReference = Object.keys(profile.accounts[service] ?? {})[0];
        if (nextReference) profile.services[service] = { reference: nextReference };
        else delete profile.services[service];
      }
    } else {
      delete profile.services[service];
    }
    await writeProfile(profilePath, profile);
    if (flags.deleteValue && reference) await new GlobalSecretStore().unset(reference);
    console.log(`Removed ${service}${reference ? ` account ${reference}` : " default account"}`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail profile list|set|unset");
}

async function authCommand(args, flags) {
  const subcommand = args[0] ?? "list";

  if (subcommand === "list") return profileCommand(["list"], flags);
  if (subcommand === "add" || subcommand === "set") {
    const service = args[1] ?? flags.service;
    const reference = args[2] ?? flags.reference;
    return profileCommand(["set", service, reference].filter(Boolean), flags);
  }
  if (subcommand === "remove" || subcommand === "rm" || subcommand === "unset") {
    const service = args[1] ?? flags.service;
    const reference = args[2] ?? flags.reference ?? flags.name;
    return profileCommand(["unset", service, reference].filter(Boolean), flags);
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail auth add|list|remove");
}

async function useCommand(args, flags, passthrough) {
  const service = args[0] ?? flags.service;
  const command = passthrough.length > 0 ? passthrough : args.slice(1);
  if (!service || command.length === 0) {
    throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail use <service> [--reference <reference>] -- <command>");
  }

  const profile = await readProfile();
  const reference = flags.reference ?? profile.services[service]?.reference;
  if (!reference) {
    throw new KeyrailError(
      "PROFILE_NOT_FOUND",
      `No ${service} account configured. Run keyrail auth add ${service} <name> --value-stdin`,
      { nextSteps: profileMissingNextSteps(service, command) }
    );
  }

  const token = await new GlobalSecretStore().get(reference);
  if (!token) {
    throw new KeyrailError(
      "SECRET_NOT_FOUND",
      `No value found for ${reference}. Run keyrail auth add ${service} ${reference} --value-stdin`,
      { nextSteps: profileValueMissingNextSteps(service, reference, command) }
    );
  }

  const env = await envForServiceCommand(service, token, command);
  const exitCode = await spawnRedacted(command, { ...process.env, ...env }, [token]);
  process.exitCode = exitCode;
}

async function withCommand(args, flags, passthrough) {
  const service = args[0] ?? flags.service;
  let reference = flags.reference;
  let commandArgs = args.slice(1);

  if (passthrough.length > 0) {
    reference = reference ?? args[1];
    commandArgs = [];
  } else if (!reference && args.length >= 3) {
    reference = args[1];
    commandArgs = args.slice(2);
  }

  return useCommand([service, ...commandArgs].filter(Boolean), { ...flags, reference }, passthrough);
}

async function secretsCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const state = await getVerifiedState(flags.context);
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });

  if (subcommand === "list") {
    const secrets = await secretBackend.listReferences(state.context.secrets);
    if (flags.json) return printJson(secrets);
    printSecretReferences(secrets);
    return;
  }

  if (subcommand === "set") {
    const provider = args[1] ?? flags.provider;
    const reference = args[2] ?? flags.reference;
    const value = flags.value ?? args[3];
    if (!provider || !reference) {
      throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail secrets set <provider> <reference> [--value <value>]");
    }
    const loaded = await loadProjectState(process.cwd());
    const contextName = await resolveProjectContextName(loaded, flags.context);
    setSecretReference(loaded.manifest, contextName, provider, reference);
    await writeProjectState(loaded);
    if (value !== undefined) {
      if (loaded.source === "user") await new GlobalSecretStore().set(reference, value);
      else await secretBackend.set(reference, value);
    }
    console.log(`Set ${provider} reference in ${contextName}`);
    return;
  }

  if (subcommand === "unset") {
    const provider = args[1] ?? flags.provider;
    if (!provider) throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail secrets unset <provider>");
    const loaded = await loadProjectState(process.cwd());
    const contextName = await resolveProjectContextName(loaded, flags.context);
    const reference = referenceNameForAttachment(getContext(loaded.manifest, contextName).secrets[provider]);
    removeSecretReference(loaded.manifest, contextName, provider);
    await writeProjectState(loaded);
    if (flags.deleteValue && reference) {
      if (loaded.source === "user") await new GlobalSecretStore().unset(reference);
      else if (typeof secretBackend.unset === "function") await secretBackend.unset(reference);
    }
    console.log(`Removed ${provider} reference from ${contextName}`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail secrets list|set|unset");
}

async function contextCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  const loaded = await loadProjectState(process.cwd());

  if (subcommand === "list") {
    const active = await resolveProjectContextName(loaded, flags.context);
    const contexts = Object.values(loaded.manifest.contexts).map((context) => ({
      name: context.name,
      risk: context.risk,
      requireConfirmation: context.requireConfirmation,
      active: context.name === active
    }));
    if (flags.json) return printJson(contexts);
    for (const context of contexts) {
      console.log(`${context.active ? "*" : " "} ${context.name} (${context.risk})${context.requireConfirmation ? " confirm" : ""}`);
    }
    return;
  }

  if (subcommand === "use") {
    const name = args[1] ?? flags.context;
    getContext(loaded.manifest, name);
    await writeActiveContext(loaded, name);
    console.log(`Using context ${name}`);
    return;
  }

  if (subcommand === "add") {
    const name = args[1] ?? flags.name;
    upsertContext(loaded.manifest, name, {
      risk: flags.risk ?? "low",
      requireConfirmation: Boolean(flags.requireConfirmation ?? flags.confirm)
    });
    await writeProjectState(loaded);
    console.log(`Added context ${name}`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1] ?? flags.name;
    removeContext(loaded.manifest, name);
    await writeProjectState(loaded);
    console.log(`Removed context ${name}`);
    return;
  }

  throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail context list|use|add|remove");
}

async function policyCommand(args, flags, passthrough = []) {
  const subcommand = args[0] ?? "show";
  const loaded = await loadProjectState(process.cwd());

  if (subcommand === "show") {
    if (flags.json) return printJson(loaded.manifest.policy);
    console.log("Allow:");
    for (const item of loaded.manifest.policy.allow) console.log(`- ${item}`);
    console.log("Require confirm:");
    for (const item of loaded.manifest.policy.requireConfirm) console.log(`- ${item}`);
    console.log("Deny:");
    for (const item of loaded.manifest.policy.deny) console.log(`- ${item}`);
    return;
  }

  if (subcommand === "preset") {
    const presetName = args[1];
    if (!presetName || flags.show) {
      const payload = presetName ? policyPresetPayload(presetName) : policyPresetListPayload();
      if (flags.json) return printJson(payload);
      printPolicyPreset(payload, Boolean(presetName));
      return;
    }
    const preset = POLICY_PRESETS[presetName];
    if (!preset) throw new KeyrailError("UNKNOWN_POLICY_PRESET", `Unknown policy preset "${presetName}". Available: ${Object.keys(POLICY_PRESETS).join(", ")}`);

    const before = clonePolicy(loaded.manifest.policy);
    const added = applyPolicyPreset(loaded.manifest.policy, preset);
    validateManifest(loaded.manifest);
    await writeProjectState(loaded);
    const payload = { name: presetName, description: preset.description, added, policy: loaded.manifest.policy, before };
    if (flags.json) return printJson(payload);
    console.log(`Applied policy preset ${presetName}: ${preset.description}`);
    printPolicyAdded(added);
    return;
  }

  if (subcommand === "allow-last") {
    const audit = await readAuditLog(loaded, 100);
    const last = [...audit].reverse().find((entry) => entry.decision === "denied" || entry.decision === "confirmation_required");
    if (!last?.command) {
      throw new KeyrailError("AUDIT_ENTRY_NOT_FOUND", "No denied or confirmation-required audit entry found for this project.");
    }

    const listName = last.decision === "confirmation_required" ? "requireConfirm" : "allow";
    if (last.decision === "denied" && (loaded.manifest.policy.deny ?? []).some((pattern) => last.command.startsWith(pattern))) {
      throw new KeyrailError("POLICY_DENIED", `Last denied command matches an explicit deny rule. Review with keyrail policy show --json before changing policy.`);
    }
    if (!loaded.manifest.policy[listName].includes(last.command)) loaded.manifest.policy[listName].push(last.command);
    validateManifest(loaded.manifest);
    await writeProjectState(loaded);

    const payload = { command: last.command, list: listName, decision: last.decision };
    if (flags.json) return printJson(payload);
    console.log(`Added policy ${listName === "requireConfirm" ? "require-confirm" : "allow"}: ${last.command}`);
    return;
  }

  const listName = {
    "allow": "allow",
    "deny": "deny",
    "require-confirm": "requireConfirm"
  }[subcommand];
  if (!listName) throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail policy show|preset|allow|allow-last|deny|require-confirm <command>");

  const command = commandFromPolicyArgs(args.slice(1), flags, passthrough);
  if (!command) throw new KeyrailError("INVALID_ARGUMENTS", `Use keyrail policy ${subcommand} <command> or keyrail policy ${subcommand} -- <command>`);
  if (!loaded.manifest.policy[listName].includes(command)) loaded.manifest.policy[listName].push(command);
  validateManifest(loaded.manifest);
  await writeProjectState(loaded);
  console.log(`Added policy ${subcommand}: ${command}`);
}

function policyPresetListPayload() {
  return Object.fromEntries(Object.entries(POLICY_PRESETS).map(([name, preset]) => [name, policyPresetPayload(name, preset)]));
}

function policyPresetPayload(name, preset = POLICY_PRESETS[name]) {
  if (!preset) throw new KeyrailError("UNKNOWN_POLICY_PRESET", `Unknown policy preset "${name}". Available: ${Object.keys(POLICY_PRESETS).join(", ")}`);
  return { name, description: preset.description, allow: preset.allow, requireConfirm: preset.requireConfirm, deny: preset.deny };
}

function clonePolicy(policy) {
  return {
    allow: [...(policy.allow ?? [])],
    requireConfirm: [...(policy.requireConfirm ?? [])],
    deny: [...(policy.deny ?? [])]
  };
}

function applyPolicyPreset(policy, preset) {
  const added = { allow: [], requireConfirm: [], deny: [] };
  for (const listName of Object.keys(added)) {
    policy[listName] = policy[listName] ?? [];
    for (const command of preset[listName] ?? []) {
      if (!policy[listName].includes(command)) {
        policy[listName].push(command);
        added[listName].push(command);
      }
    }
  }
  return added;
}

function printPolicyPreset(payload, single) {
  if (!single) {
    console.log("Policy presets:");
    for (const preset of Object.values(payload)) console.log(`- ${preset.name}: ${preset.description}`);
    console.log("Show: keyrail policy preset <name> --show");
    console.log("Apply: keyrail policy preset <name>");
    return;
  }
  console.log(`Policy preset ${payload.name}: ${payload.description}`);
  console.log("Allow:");
  for (const item of payload.allow) console.log(`- ${item}`);
  console.log("Require confirm:");
  for (const item of payload.requireConfirm) console.log(`- ${item}`);
  console.log("Deny:");
  for (const item of payload.deny) console.log(`- ${item}`);
}

function printPolicyAdded(added) {
  for (const [listName, commands] of Object.entries(added)) {
    console.log(`${listName}: ${commands.length ? commands.join(", ") : "no changes"}`);
  }
}

async function syncCommand(args, flags) {
  const target = args[0];
  if (target !== "vercel-env") {
    throw new KeyrailError("INVALID_ARGUMENTS", "Use keyrail sync vercel-env [--dry-run] [--json] [--target <environment>] [--project <vercel-project>] [--yes]");
  }

  const state = await getVerifiedState(flags.context);
  const backend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const vercelReference = state.context.secrets.vercel;
  const targetReferences = Object.fromEntries(Object.entries(state.context.secrets ?? {}).filter(([provider]) => provider !== "vercel"));
  const secrets = await backend.resolveReferences(targetReferences);
  const vercelToken = await resolveVercelTokenForSync({ backend, state, vercelReference, dryRun: Boolean(flags.dryRun) });
  const vercelProject = flags.project ?? state.manifest.project.id;
  const envTarget = flags.target ?? defaultVercelEnvTarget(state.context.name);
  const plan = buildVercelEnvSyncPlan(secrets, { vercelProject, envTarget, yes: Boolean(flags.yes) });
  const subprocessOutput = [];
  let synced = [];
  let failed = [];

  if (!flags.dryRun && secrets.missing.length > 0) {
    await auditVercelEnvSync(state, flags, plan, secrets.missing, synced, failed);
    throw await missingSecretsError(secrets.missing, state);
  }

  if (!flags.dryRun && plan.entries.length > 0) {
    for (const entry of plan.entries) {
      const result = await spawnWithInputRedacted(entry.command, `${entry.value}\n`, {
        env: { ...process.env, VERCEL_TOKEN: vercelToken.value },
        secretValues: [entry.value, vercelToken.value],
        inheritOutput: !flags.json
      });
      subprocessOutput.push({ envName: entry.envName, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
      if (result.exitCode === 0) synced.push(entry.output);
      else {
        failed.push({ ...entry.output, exitCode: result.exitCode });
        break;
      }
    }
  }

  const payload = {
    project: {
      id: state.manifest.project.id,
      name: state.manifest.project.name,
      root: state.root
    },
    context: {
      name: state.context.name,
      risk: state.context.risk,
      requireConfirmation: state.context.requireConfirmation
    },
    target: "vercel-env",
    vercelProject,
    envTarget,
    auth: {
      provider: "vercel",
      envName: "VERCEL_TOKEN",
      configured: Boolean(vercelToken.value)
    },
    synced,
    failed,
    wouldSync: plan.wouldSync,
    missing: secrets.missing.map(formatSecretForOutput),
    commands: plan.commands,
    output: flags.json ? subprocessOutput : undefined,
    dryRun: Boolean(flags.dryRun)
  };

  await auditVercelEnvSync(state, flags, plan, secrets.missing, synced, failed);

  if (failed.length > 0) {
    const failedNames = failed.map((item) => item.envName).join(", ");
    const error = new KeyrailError("VERCEL_ENV_SYNC_FAILED", `vercel env add failed for ${failedNames}. Output was redacted.`);
    if (flags.json) {
      payload.error = { code: error.code, message: error.message };
      printJson(payload);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (flags.json) return printJson(payload);
  printVercelEnvSync(payload);
}

async function resolveVercelTokenForSync({ backend, state, vercelReference, dryRun }) {
  if (!vercelReference) {
    if (dryRun) return { value: null };
    const remediation = await remediationForUnattachedSecret("vercel", state);
    throw new KeyrailError(
      "SECRET_NOT_FOUND",
      `VERCEL_TOKEN is not configured for this project. ${remediation.message}`,
      { nextSteps: remediation.nextSteps }
    );
  }

  const tokenSecrets = await backend.resolveReferences({ vercel: vercelReference });
  if (tokenSecrets.missing.length > 0) {
    if (dryRun) return { value: null };
    throw await missingSecretsError(tokenSecrets.missing, state);
  }

  const tokenEnvName = tokenSecrets.resolved[0]?.envName ?? "VERCEL_TOKEN";
  return { value: tokenSecrets.env[tokenEnvName] ?? null };
}

function defaultVercelEnvTarget(contextName) {
  const normalized = String(contextName ?? "").toLowerCase();
  if (["production", "prod"].includes(normalized)) return "production";
  if (["preview", "staging", "stage", "test", "testing"].includes(normalized)) return "preview";
  if (["development", "dev", "local", "default"].includes(normalized)) return "development";
  return normalized || "development";
}

function buildVercelEnvSyncPlan(secrets, { vercelProject, envTarget, yes }) {
  const entries = secrets.resolved.map((secret) => {
    const output = formatSecretForOutput(secret);
    const command = ["vercel", "env", "add", output.envName, envTarget, "--project", vercelProject];
    if (yes) command.push("--yes");
    return {
      ...output,
      output,
      value: secrets.env[output.envName],
      command
    };
  });
  const wouldSync = entries.map((entry) => entry.output);
  return {
    entries,
    wouldSync,
    commands: entries.map((entry) => entry.command.join(" "))
  };
}

async function auditVercelEnvSync(state, flags, plan, missing, synced, failed) {
  await appendAudit(state, {
    at: new Date().toISOString(),
    project: state.manifest.project.id,
    context: state.context.name,
    command: normalizeCommand(["keyrail", "sync", "vercel-env"]),
    decision: flags.dryRun ? "dry_run" : (failed.length ? "failed" : (missing.length ? "missing_secrets" : "allowed")),
    injected: plan.wouldSync,
    synced: synced.map((secret) => secret.envName),
    missing: missing.map(formatSecretForOutput),
    missingEnvNames: missing.map((secret) => formatSecretForOutput(secret).envName),
    failed: failed.map((secret) => secret.envName)
  });
}

function printVercelEnvSync(payload) {
  console.log(`Vercel env sync: ${payload.project.name} (${payload.project.id})`);
  console.log(`Context: ${payload.context.name}`);
  console.log(`Vercel project: ${payload.vercelProject}`);
  console.log(`Target: ${payload.envTarget}`);
  console.log(payload.dryRun ? "Mode: dry-run" : "Mode: sync");
  if (!payload.auth.configured) console.log("Vercel auth: missing VERCEL_TOKEN");
  if (payload.wouldSync.length) {
    console.log("Would sync:");
    for (const secret of payload.wouldSync) console.log(`- ${secret.envName}${secret.alias ? " (alias)" : ""} from ${secret.provider}:${secret.reference}`);
  } else {
    console.log("Would sync: none");
  }
  if (payload.missing.length) {
    console.log("Missing:");
    for (const secret of payload.missing) console.log(`- ${secret.envName}: ${remediationMessageForSecret(secret)}`);
  }
  if (payload.synced.length) {
    console.log("Synced:");
    for (const secret of payload.synced) console.log(`- ${secret.envName}`);
  }
  if (payload.failed.length) {
    console.log("Failed:");
    for (const secret of payload.failed) console.log(`- ${secret.envName}`);
  }
  if (payload.dryRun && payload.commands.length) {
    console.log("Commands:");
    for (const command of payload.commands) console.log(`- ${command}`);
  }
}

async function auditCommand(args, flags) {
  const subcommand = args[0] ?? "list";
  if (subcommand !== "list") throw new KeyrailError("UNKNOWN_COMMAND", "Use keyrail audit list");
  const loaded = await loadProjectState(process.cwd());
  const audit = await readAuditLog(loaded, Number(flags.limit ?? 50));
  if (flags.json) return printJson(audit);
  if (!audit.length) {
    console.log("Audit: none");
    return;
  }
  for (const entry of audit) {
    console.log(`${entry.at} ${entry.project}/${entry.context} ${entry.decision ?? "allowed"} ${entry.command}`);
  }
}

async function serveCommand(flags) {
  const { createServer } = await import("node:http");
  const port = Number(flags.port ?? 7788);
  const host = flags.host ?? "127.0.0.1";
  const token = flags.token ?? process.env.KEYRAIL_UI_TOKEN ?? randomBytes(18).toString("base64url");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /") {
        if (!isUiRequestAuthorized(req, url, token)) return sendUnauthorized(res);
        const html = await renderUiHtml(process.cwd(), token);
        send(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (url.pathname.startsWith("/api/") && !isUiRequestAuthorized(req, url, token)) {
        sendUnauthorized(res);
        return;
      }

      if (route === "GET /api/state") {
        const state = await getStateForUi(process.cwd(), url.searchParams.get("context"));
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(state));
        return;
      }

      if (route === "POST /api/context") {
        const body = await readJsonBody(req);
        const loaded = await loadProjectState(process.cwd());
        getContext(loaded.manifest, body.context);
        await writeActiveContext(loaded, body.context);
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, context: body.context }));
        return;
      }

      if (route === "POST /api/manifest") {
        const body = await readJsonBody(req);
        const loaded = await loadProjectState(process.cwd());
        const nextManifest = {
          project: body.project ?? loaded.manifest.project,
          contexts: body.contexts ?? loaded.manifest.contexts,
          policy: body.policy ?? loaded.manifest.policy
        };
        loaded.manifest = nextManifest;
        await writeProjectState(loaded);
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }

      if (route === "POST /api/secret") {
        const body = await readJsonBody(req);
        const loaded = await loadProjectState(process.cwd());
        if (loaded.source === "user") await new GlobalSecretStore().set(body.reference, body.value);
        else {
          const backend = createSecretBackend({ type: "local-file", root: loaded.root });
          await backend.set(body.reference, body.value);
        }
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }

      if (route === "GET /api/audit") {
        const loaded = await loadProjectState(process.cwd());
        const audit = await readAuditLog(loaded);
        send(res, 200, "application/json; charset=utf-8", JSON.stringify(audit));
        return;
      }

      send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not_found" }));
    } catch (error) {
      send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: error.message, code: error.code ?? "error" }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch((error) => {
    throw new KeyrailError("UI_SERVER_ERROR", `Unable to start UI server on ${host}:${port}`, {
      code: error.code,
      address: error.address,
      port: error.port
    });
  });

  console.log(`Keyrail UI running at http://${host}:${port}/?token=${token}`);
}

async function getVerifiedState(contextName) {
  const loaded = await loadProjectState(process.cwd());
  const activeContextName = await resolveProjectContextName(loaded, contextName);
  const context = getContext(loaded.manifest, activeContextName);
  const identity = await identifyProject(loaded.root, loaded.manifest);
  const verification = verifyIdentity(identity, loaded.manifest);
  return { ...loaded, context, identity, verification };
}

function parseArgs(argv) {
  const passthroughIndex = argv.indexOf("--");
  const before = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  const passthrough = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
  const [command, ...rawArgs] = before;
  const flags = {};
  const args = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg.startsWith("--") && rawArgs[index + 1] && !rawArgs[index + 1].startsWith("--")) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = true;
    } else {
      args.push(arg);
    }
  }

  return { command, args, flags, passthrough };
}

function printSecretReferences(secrets) {
  if (!secrets.length) {
    console.log("Secrets: none");
    return;
  }
  console.log("Secrets:");
  for (const secret of secrets) {
    console.log(`- ${secret.provider}: ${secret.reference} -> ${secret.envName}${secret.alias ? " (alias)" : ""} (${secret.configured ? "configured" : "reference only"})`);
  }
}

function printServiceLinks(services) {
  if (!services.length) {
    console.log("Linked services: none");
    return;
  }
  console.log("Linked services:");
  for (const service of services) {
    const name = service.service ?? service.provider;
    const envName = service.envName ? ` -> ${service.envName}${service.alias ? " (alias)" : ""}` : "";
    console.log(`- ${name}: ${service.reference}${envName} (${service.configured ? "configured" : "reference only"})`);
  }
}

async function buildStatusPayload(state, flags = {}) {
  const secretBackend = createSecretBackend({ type: flags.secretBackend ?? "local-file", root: state.root });
  const secrets = await secretBackend.listReferences(state.context.secrets);
  const services = secrets.map((secret) => ({
    service: secret.provider,
    reference: secret.reference,
    envName: secret.envName,
    alias: secret.alias,
    configured: secret.configured,
    state: secret.configured ? "configured" : "missing"
  }));
  const missingCount = services.filter((service) => !service.configured).length;
  const nextCommand = nextRecommendedCommand(services, missingCount);
  const suggestions = await buildStatusSuggestions(state, services);
  const missing = services.filter((service) => !service.configured);
  const nextSteps = buildStatusNextSteps({
    state,
    verification: state.verification,
    services,
    missing,
    suggestions
  });
  const audit = await readAuditLog(state);
  const policyRepair = buildPolicyRepairState(audit, state.manifest.policy);
  const vercelEnvSync = buildVercelEnvSyncPanel({
    project: state.manifest.project,
    context: state.context,
    services,
    vercelProject: flags.project ?? state.manifest.project.id,
    envTarget: flags.target ?? defaultVercelEnvTarget(state.context.name),
    yes: Boolean(flags.yes)
  });

  return {
    project: state.manifest.project,
    root: state.root,
    context: state.context,
    identity: state.identity,
    verification: state.verification,
    services,
    deployment: {
      project: {
        id: state.manifest.project.id,
        name: state.manifest.project.name,
        root: state.root
      },
      context: {
        name: state.context.name,
        risk: state.context.risk,
        requireConfirmation: state.context.requireConfirmation
      },
      services,
      ready: missingCount === 0,
      missingCount,
      nextCommand
    },
    agent: {
      verified: true,
      instruction: "Use keyrail run -- <command> so this project receives only its linked service keys."
    },
    suggestions,
    nextSteps,
    policyRepair,
    vercelEnvSync
  };
}

async function buildStatusSuggestions(state, services) {
  const profile = await readProfile();
  const attachedServices = new Set(services.map((service) => service.service));
  const relevantServices = servicesRelevantToProject(state, profile);
  const suggestions = [];

  for (const service of relevantServices) {
    if (attachedServices.has(service)) continue;
    const accounts = Object.keys(profile.accounts[service] ?? {}).sort();
    for (const reference of accounts) {
      suggestions.push({
        type: "attach",
        service,
        reference,
        command: `keyrail attach ${service} ${reference}`,
        reason: `Local ${service} account is available but not attached to this project.`
      });
    }
  }

  return suggestions;
}

function servicesRelevantToProject(state, profile) {
  const available = new Set(Object.keys(profile.accounts ?? {}));
  const relevant = new Set(Object.keys(state.context.secrets ?? {}));
  const policyCommands = [
    ...(state.manifest.policy.allow ?? []),
    ...(state.manifest.policy.requireConfirm ?? []),
    ...(state.manifest.policy.deny ?? [])
  ].join(" ");
  const repo = state.manifest.project.repo ?? state.identity.gitRemote ?? "";

  if (available.has("github") && (/\bgh\b|\bgithub\b/i.test(policyCommands) || /github\.com[:/]/i.test(repo))) {
    relevant.add("github");
  }
  if (available.has("vercel") && /\bvercel\b/i.test(policyCommands)) {
    relevant.add("vercel");
  }

  return [...relevant].filter((service) => available.has(service)).sort();
}

function buildVercelEnvSyncPanel({ project, context, services, vercelProject, envTarget, yes = false }) {
  const auth = services.find((service) => service.service === "vercel");
  const mappings = services
    .filter((service) => service.service !== "vercel")
    .map((service) => ({
      service: service.service,
      reference: service.reference,
      envName: service.envName,
      alias: Boolean(service.alias),
      configured: Boolean(service.configured),
      status: service.configured ? "ready" : "missing",
      command: vercelEnvDryRunCommand({ project, envTarget, vercelProject, envName: service.envName, yes })
    }));
  return {
    target: "vercel-env",
    vercelProject,
    envTarget,
    auth: auth ? {
      service: auth.service,
      reference: auth.reference,
      envName: auth.envName,
      configured: Boolean(auth.configured),
      status: auth.configured ? "ready" : "missing"
    } : { service: "vercel", envName: "VERCEL_TOKEN", configured: false, status: "unattached" },
    mappings,
    dryRunCommand: `keyrail sync vercel-env --dry-run --target ${envTarget} --project ${vercelProject}`,
    note: "Dry-run commands show env names and references only; Keyrail never renders secret values."
  };
}

function vercelEnvDryRunCommand({ envTarget, vercelProject }) {
  return `keyrail sync vercel-env --dry-run --target ${envTarget} --project ${vercelProject}`;
}

function printVercelEnvSyncSummary(panel) {
  console.log("Vercel env sync:");
  console.log(`- auth: ${panel.auth.envName} (${panel.auth.status})`);
  console.log(`- target: ${panel.envTarget} / project ${panel.vercelProject}`);
  if (panel.mappings.length) {
    for (const mapping of panel.mappings) console.log(`- ${mapping.envName}${mapping.alias ? " (alias)" : ""}: ${mapping.status} from ${mapping.service}:${mapping.reference}`);
  } else {
    console.log("- mappings: none (attach non-Vercel secrets to sync)");
  }
  console.log(`- dry-run: ${panel.dryRunCommand}`);
}

function printPolicyRepair(repair) {
  console.log("Policy repair:");
  console.log(`- ${repair.decision}: ${repair.command}`);
  if (repair.reason) console.log(`- reason: ${repair.reason}`);
  for (const step of repair.nextSteps ?? []) console.log(`- ${step.command} (${step.reason})`);
}

function printDeploymentStatus(payload) {
  console.log(`${payload.project.name} (${payload.project.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context.name} (${payload.context.risk})`);
  console.log(`Identity: ${payload.verification.reason}`);
  if (!payload.services.length) {
    console.log("Services: none attached");
  } else {
    console.log("Services:");
    for (const service of payload.services) {
      console.log(`- ${service.service}: ${service.envName}${service.alias ? " (alias)" : ""} (${service.configured ? "configured" : "missing"})`);
    }
  }
  if (payload.vercelEnvSync) printVercelEnvSyncSummary(payload.vercelEnvSync);
  if (payload.policyRepair) printPolicyRepair(payload.policyRepair);
  if (payload.suggestions?.length) {
    console.log("Suggestions:");
    for (const suggestion of payload.suggestions) {
      console.log(`- ${suggestion.command}`);
    }
  }
  if (payload.nextSteps?.length) {
    console.log("Next steps:");
    for (const step of payload.nextSteps) console.log(`- ${step.command} (${step.reason})`);
  }
  console.log(`Next: ${payload.deployment.nextCommand}`);
}

function printDoctor(payload) {
  console.log(`Keyrail doctor: ${payload.project.name} (${payload.project.id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Context: ${payload.context.name} (${payload.context.risk})`);
  for (const check of payload.checks) {
    console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  if (payload.services.length) {
    console.log("Linked services:");
    for (const service of payload.services) {
      console.log(`- ${service.service}: ${service.envName}${service.alias ? " (alias)" : ""} (${service.configured ? "configured" : "missing"})`);
    }
  } else {
    console.log("Linked services: none");
  }
  if (payload.suggestions.length) {
    console.log("Suggested attachments:");
    for (const suggestion of payload.suggestions) console.log(`- ${suggestion.command}`);
  }
  console.log("Command policy guidance:");
  for (const guidance of payload.policyGuidance) {
    console.log(`- ${guidance.command}: ${guidance.status}${guidance.nextCommand ? `; ${guidance.nextCommand}` : ""}`);
  }
  if (payload.nextSteps.length) {
    console.log("Next steps:");
    for (const step of payload.nextSteps) console.log(`- ${step.command} (${step.reason})`);
  } else {
    console.log("Next steps: none");
  }
}

function printDryRun(payload) {
  console.log(`Dry run: ${payload.command}`);
  console.log(`Project: ${payload.project.name} (${payload.project.id})`);
  console.log(`Root: ${payload.project.root}`);
  console.log(`Context: ${payload.context.name} (${payload.context.risk})`);
  console.log(`Policy: ${payload.policy.allowed ? "allowed" : "denied"}`);
  if (!payload.injected.length) {
    console.log("Would inject: none");
  } else {
    console.log("Would inject:");
    for (const secret of payload.injected) {
      console.log(`- ${secret.envName}${secret.alias ? " (alias)" : ""} from ${secret.provider}:${secret.reference}`);
    }
  }
  if (!payload.missing.length) {
    console.log("Missing: none");
  } else {
    console.log("Missing:");
    for (const secret of payload.missing) {
      console.log(`- ${secret.envName}: ${remediationMessageForSecret(secret)}`);
    }
  }
}

function nextRecommendedCommand(services, missingCount) {
  if (!services.length) return "keyrail attach <service> <reference> --value-stdin";
  if (missingCount > 0) {
    const firstMissing = services.find((service) => !service.configured);
    if (firstMissing.service === "vercel") return "keyrail deploy vercel --dry-run";
    return setupCommandForSecret(firstMissing);
  }
  if (services.some((service) => service.service === "vercel")) return "keyrail deploy vercel --dry-run";
  return "keyrail run --dry-run -- <command>";
}

async function buildRunReferences(state, flags) {
  const references = { ...(state.context.secrets ?? {}) };
  const requested = splitWithReferences(flags.with);
  if (!requested.length) return references;

  const profile = await readProfile();
  for (const item of requested) {
    const provider = item;
    const attached = references[provider];
    if (attached) {
      references[provider] = attached;
      continue;
    }

    const profileReference = profile.services[provider]?.reference;
    references[provider] = profileReference ?? item;
  }
  return references;
}

function splitWithReferences(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function formatSecretForOutput(secret) {
  const envName = secret.envName ?? envNameForProvider(secret.provider);
  return {
    provider: secret.provider,
    reference: secret.reference,
    envName,
    alias: Boolean(secret.alias)
  };
}

function referenceNameForAttachment(entry) {
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.reference;
}

async function missingSecretsError(missing, state = null) {
  const withEnvNames = missing.map(formatSecretForOutput);
  const remediations = state
    ? await Promise.all(withEnvNames.map((secret) => remediationForMissingSecret(secret, state)))
    : withEnvNames.map((secret) => ({
        message: remediationMessageForSecret(secret),
        nextSteps: [nextStep(`keyrail attach ${secret.provider} ${secret.reference} --value-stdin`, `Configure ${secret.envName}.`)]
      }));
  const first = withEnvNames[0];
  const message = withEnvNames.length === 1
    ? `${first.envName} is not configured. ${remediations[0].message}`
    : `${withEnvNames.length} secret references are not configured. ${remediations.map((item) => item.message).join(" ")}`;
  return new KeyrailError("SECRET_NOT_FOUND", message, {
    missing: withEnvNames,
    nextSteps: remediations.flatMap((item) => item.nextSteps)
  });
}

function remediationMessageForSecret(secret) {
  if (secret.provider === "vercel") {
    return `Run keyrail deploy vercel --dry-run to inspect readiness, then keyrail auth add vercel ${secret.reference} --value-stdin to configure ${secret.envName ?? envNameForProvider(secret.provider)}.`;
  }
  return `Run ${setupCommandForSecret(secret)} to configure ${secret.envName ?? envNameForProvider(secret.provider)}, or run keyrail doctor.`;
}

async function remediationForMissingSecret(secret, state) {
  const suggestions = await suggestionsForService(secret.provider, state);
  const exact = suggestions.find((suggestion) => suggestion.reference === secret.reference);
  const nextSteps = missingSecretNextSteps(secret);
  if (exact) {
    return {
      message: `Run ${nextSteps[0].command}, then retry.`,
      nextSteps
    };
  }

  return {
    message: remediationMessageForSecret(secret),
    nextSteps
  };
}

async function remediationForUnattachedSecret(provider, state) {
  const envName = envNameForProvider(provider);
  const suggestions = await suggestionsForService(provider, state);
  if (suggestions.length === 1) {
    const command = attachCommandForProvider(provider, suggestions[0].reference);
    return {
      message: `Run ${command}, then retry.`,
      nextSteps: [
        nextStep(command, attachReasonForProvider(provider, envName)),
        nextStep(verifyCommandForProvider(provider), verifyReasonForProvider(provider))
      ]
    };
  }

  if (suggestions.length > 1) {
    return {
      message: `Choose an account with ${attachCommandForProvider(provider, "<reference>")}, then retry.`,
      nextSteps: [
        ...suggestions.map((suggestion) => nextStep(attachCommandForProvider(provider, suggestion.reference), `Attach ${provider}:${suggestion.reference}.`)),
        nextStep(verifyCommandForProvider(provider), verifyReasonForProvider(provider))
      ]
    };
  }

  if (provider === "vercel") {
    return {
      message: "Run keyrail deploy vercel --dry-run to inspect readiness, then add and attach a Vercel token.",
      nextSteps: [
        nextStep("keyrail deploy vercel --dry-run", "Inspect Vercel deployment readiness and token routing."),
        nextStep("keyrail auth add vercel <name> --value-stdin", `Save ${envName} from stdin as a reusable local Vercel account.`),
        nextStep("keyrail attach vercel <name>", "Attach the Vercel account to this project.")
      ]
    };
  }

  return {
    message: `Run ${setupCommandForProvider(provider, "<name>")} and attach it with ${attachCommandForProvider(provider, "<name>")}, then retry.`,
    nextSteps: [
      nextStep(setupCommandForProvider(provider, "<name>"), `Save ${envName} from stdin as a reusable local ${provider} account.`),
      nextStep(attachCommandForProvider(provider, "<name>"), attachReasonForProvider(provider, envName))
    ]
  };
}

async function remediationForPolicyDecision(decision, command, state, flags = {}) {
  const normalized = normalizeCommand(command);
  if (decision.requiresConfirmation) {
    const confirmCommand = confirmationCommandFor(normalized, flags);
    return {
      message: "Retry with --yes or set KEYRAIL_CONFIRM=1 after confirming the project/context.",
      nextSteps: [
        nextStep(confirmCommand, "Confirm this command for the current context."),
        nextStep("KEYRAIL_CONFIRM=1 keyrail run -- <command>", "Alternative confirmation form for non-interactive runners."),
        nextStep("keyrail policy allow-last", "Promote this last confirmation-required audit command into require-confirm policy."),
        nextStep("keyrail doctor", "Review identity, context risk, and policy guidance.")
      ]
    };
  }

  const provider = providerForCommand(normalized);
  if (provider === "github") {
    const action = githubActionForCommand(normalized);
    const name = referenceNameForAttachment(state.context.secrets.github) ?? "<name>";
    return {
      message: `Route GitHub ${action} through a saved account or add a narrow policy rule with ${policyActionForCommand(normalized, state.manifest.policy)}.`,
      nextSteps: [
        nextStep(githubWithCommand(name, normalized), `Retry GitHub ${action} with GITHUB_TOKEN/GH_TOKEN injected.`),
        nextStep(`keyrail auth add github ${name} --value-stdin`, "Save a GitHub token from stdin if the account is not configured."),
        nextStep(attachCommandForProvider("github", name), "Attach the GitHub account to this project if it should be the default.")
      ]
    };
  }

  const policyAction = policyActionForCommand(normalized, state.manifest.policy);
  return {
    message: `Review with keyrail doctor or allow it with ${policyAction}.`,
    nextSteps: policyRepairNextSteps(normalized, "denied", explicitDenyForCommand(normalized, state.manifest.policy), true)
  };
}

function confirmationCommandFor(command, flags = {}) {
  if (command.startsWith("vercel deploy")) {
    return `keyrail deploy vercel${command.includes("--prod") ? " --prod" : ""} --yes${flags.dryRun ? " --dry-run" : ""}`;
  }
  return `keyrail run --yes -- ${command}`;
}

function explicitDenyForCommand(command, policy) {
  return (policy.deny ?? []).find((pattern) => command.startsWith(pattern)) ?? null;
}

function policyActionForCommand(command, policy) {
  const denied = explicitDenyForCommand(command, policy);
  if (denied) return `keyrail policy show --json # denied by "${denied}"`;
  return `keyrail policy allow -- ${command}`;
}

async function suggestionsForService(service, state) {
  const profile = await readProfile();
  return Object.keys(profile.accounts[service] ?? {}).sort().map((reference) => ({
    type: "attach",
    service,
    reference,
    command: `keyrail attach ${service} ${reference}`,
    reason: `Local ${service} account is available but not attached to this project.`
  }));
}

function buildDoctorNextSteps({ state, verification, services, missing, suggestions }) {
  return buildStatusNextSteps({ state, verification, services, missing, suggestions });
}

function buildStatusNextSteps({ state, verification, services, missing, suggestions }) {
  const steps = [];
  if (!verification.verified) {
    steps.push(nextStep("keyrail doctor", "Review the identity mismatch before routing credentials."));
  }
  for (const suggestion of suggestions) {
    steps.push(nextStep(attachCommandForProvider(suggestion.service, suggestion.reference), suggestion.reason));
  }
  for (const secret of missing) {
    steps.push(...missingSecretNextSteps(secret));
    const provider = secret.provider ?? secret.service;
    if (provider === "supabase") steps.push(nextStep("keyrail run --dry-run -- supabase db push", "Check Supabase policy and injected env var names before execution."));
  }
  if (!services.length && !suggestions.length) {
    steps.push(nextStep("keyrail auth add <service> <name> --value-stdin", "Save the service account this project needs without exposing the secret."));
    steps.push(nextStep("keyrail attach <service> <name>", "Attach the saved service account to this project."));
  }
  steps.push(nextStep("keyrail run --dry-run -- <command>", "Check policy and injected env var names before execution."));
  if (services.some((service) => service.service === "vercel")) {
    steps.push(nextStep("keyrail deploy vercel --dry-run", "Validate the Vercel deployment path."));
  }
  return dedupeNextSteps(steps);
}

function setupCommandForSecret(secret) {
  return setupCommandForProvider(secret.provider ?? secret.service, secret.reference);
}

function setupCommandForProvider(provider, reference) {
  if (provider === "vercel") return "keyrail deploy vercel --dry-run";
  return `keyrail auth add ${provider} ${reference} --value-stdin`;
}

function missingSecretNextSteps(secret) {
  const provider = secret.provider ?? secret.service;
  if (provider === "vercel") {
    return [
      nextStep("keyrail deploy vercel --dry-run", `Validate Vercel deployment readiness and ${secret.envName ?? envNameForProvider(provider)} routing.`),
      nextStep(`keyrail auth add vercel ${secret.reference} --value-stdin`, `Store ${secret.envName ?? envNameForProvider(provider)} from stdin for the linked Vercel reference.`),
      nextStep(attachCommandForProvider("vercel", secret.reference), "Attach the Vercel token reference used by this project.")
    ];
  }
  return [
    nextStep(setupCommandForSecret(secret), setupReasonForSecret(secret)),
    nextStep(verifyCommandForProvider(provider), verifyReasonForProvider(provider))
  ];
}

function attachCommandForProvider(provider, reference) {
  if (provider === "vercel") return `keyrail attach vercel ${reference}`;
  return `keyrail attach ${provider} ${reference}`;
}

function setupReasonForSecret(secret) {
  const provider = secret.provider ?? secret.service;
  const envName = secret.envName ?? envNameForProvider(provider);
  if (provider === "vercel") return `Validate Vercel deployment readiness and ${envName} routing.`;
  return `Store ${envName} for the linked ${provider} reference from stdin.`;
}

function attachReasonForProvider(provider, envName) {
  if (provider === "vercel") return `Attach the Vercel account so ${envName} can be routed for deploys.`;
  return `Attach the saved ${provider} account so ${envName} can be routed for commands.`;
}

function verifyCommandForProvider(provider) {
  if (provider === "vercel") return "keyrail deploy vercel --dry-run";
  if (provider === "supabase") return "keyrail run --dry-run -- supabase db push";
  return "keyrail doctor";
}

function verifyReasonForProvider(provider) {
  if (provider === "vercel") return "Validate linked-service readiness for Vercel deploys.";
  if (provider === "supabase") return "Validate Supabase policy and credential routing.";
  return "Verify project routing and linked-service readiness.";
}

function profileMissingNextSteps(service, command) {
  const name = "<name>";
  const steps = [
    nextStep(`keyrail auth add ${service} ${name} --value-stdin`, `Save ${envNameForProvider(service)} from stdin.`)
  ];
  if (service === "github") steps.push(nextStep(githubWithCommand(name, normalizeCommand(command)), "Retry the GitHub command with token injection."));
  return steps;
}

function profileValueMissingNextSteps(service, reference, command) {
  const steps = [
    nextStep(`keyrail auth add ${service} ${reference} --value-stdin`, `Store ${envNameForProvider(service)} from stdin.`)
  ];
  if (service === "github") steps.push(nextStep(githubWithCommand(reference, normalizeCommand(command)), "Retry the GitHub command with token injection."));
  return steps;
}

function providerForCommand(command) {
  if (/^(git\s+(push|clone|fetch|pull)|gh\s+|github\b)/.test(command) || /github\.com[:/]/i.test(command)) return "github";
  if (/^vercel\b/.test(command)) return "vercel";
  if (/^supabase\b/.test(command)) return "supabase";
  return null;
}

function githubActionForCommand(command) {
  if (command.startsWith("git push")) return "push";
  if (command.startsWith("git clone") || command.startsWith("gh repo clone")) return "clone";
  return "auth";
}

function githubWithCommand(reference, command) {
  return `keyrail with github ${reference} -- ${command}`;
}

function buildPolicyGuidance(state) {
  const commands = [
    ["gh issue list", "GitHub read-only project command"],
    ["vercel deploy", "Vercel deploy"],
    ["vercel deploy --prod", "Production Vercel deploy"],
    ["supabase db push", "Supabase schema push"],
    ["gh repo delete", "Repository deletion"]
  ];
  return commands.map(([command, description]) => {
    const decision = evaluatePolicy({
      command: command.split(/\s+/),
      context: state.context,
      policy: state.manifest.policy,
      confirmed: false
    });
    const status = decision.allowed ? "allowed" : (decision.requiresConfirmation ? "requires confirmation" : "denied");
    let nextCommand = `keyrail run --dry-run -- ${command}`;
    if (decision.requiresConfirmation) nextCommand = `keyrail run --yes -- ${command}`;
    else if (!decision.allowed) {
      nextCommand = (state.manifest.policy.deny ?? []).some((pattern) => command.startsWith(pattern))
        ? "keyrail policy show --json"
        : `keyrail policy allow -- ${command}`;
    }
    return { command, description, status, reason: decision.reason ?? "allowed", nextCommand };
  });
}

function verifyProjectIdentity(identity, manifest) {
  try {
    return verifyIdentity(identity, manifest);
  } catch (error) {
    return {
      verified: false,
      reason: error.message,
      code: error.code ?? "IDENTITY_UNVERIFIED",
      expected: error.details?.expected,
      actual: error.details?.actual
    };
  }
}

function embeddedCredentialRemote(remote) {
  if (!remote) return null;
  const match = remote.match(/^[a-z][a-z0-9+.-]*:\/\/([^/\s@]+)@([^/\s]+)/i);
  if (!match) return null;
  return { userinfo: match[1], host: match[2] };
}

function nextStep(command, reason) {
  return { command, reason };
}

function dedupeNextSteps(steps) {
  const seen = new Set();
  return steps.filter((step) => {
    if (seen.has(step.command)) return false;
    seen.add(step.command);
    return true;
  });
}

async function spawnRedacted(command, env, secretValues) {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        env,
        shell: false,
        stdio: ["inherit", "pipe", "pipe"]
      });

      child.stdout.on("data", (chunk) => process.stdout.write(redactSecrets(chunk.toString(), secretValues)));
      child.stderr.on("data", (chunk) => process.stderr.write(redactSecrets(chunk.toString(), secretValues)));
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    if (env.KEYRAIL_CLEANUP_DIR) await rm(env.KEYRAIL_CLEANUP_DIR, { recursive: true, force: true });
  }
}

async function spawnWithInputRedacted(command, input, options = {}) {
  const secretValues = options.secretValues ?? [];
  const env = options.env ?? process.env;
  const inheritOutput = options.inheritOutput ?? true;

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const redacted = redactSecrets(chunk.toString(), secretValues);
      stdout += redacted;
      if (inheritOutput) process.stdout.write(redacted);
    });
    child.stderr.on("data", (chunk) => {
      const redacted = redactSecrets(chunk.toString(), secretValues);
      stderr += redacted;
      if (inheritOutput) process.stderr.write(redacted);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function appendAudit(state, audit) {
  const dir = state.source === "user" ? path.join(getKeyrailConfigRoot(), "audit") : path.join(state.root, ".keyrail");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(audit)}\n`;
  const { appendFile } = await import("node:fs/promises");
  const file = state.source === "user" ? `${projectKeyForRoot(state.root)}.log` : "audit.log";
  await appendFile(path.join(dir, file), line, { mode: 0o600 });
}

function pass(name, message) {
  return { name, status: "pass", message };
}

function warn(name, message) {
  return { name, status: "warn", message };
}

function fail(name, message) {
  return { name, status: "fail", message };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function resolveConfirmation(flags, state) {
  if (flags.yes || process.env.KEYRAIL_CONFIRM === "1") return true;
  const context = state.context;
  const needsPrompt = context.risk === "high" || context.requireConfirmation;
  if (!needsPrompt) return false;

  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const expected = `${state.manifest.project.id}/${context.name}`;
    const answer = await rl.question(`Type ${expected} to confirm high-risk execution: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`Keyrail

Usage:
  keyrail auth add github <name> [--value-stdin]
  keyrail attach <service> <name> [--value <secret>]
  keyrail detach <service>
  keyrail with github [name] -- <command>
  keyrail status [--json] [--context <name>]
  keyrail run [--dry-run] [--context <name>] [--yes] -- <command>
  keyrail deploy vercel [--prod] [--yes] [--dry-run]
  keyrail sync vercel-env [--dry-run] [--json] [--target <environment>] [--project <vercel-project>] [--yes]
  keyrail ui [--port <port>] [--token <token>]

Advanced:
  keyrail init [--id <id>] [--name <name>] [--repo <url|local>] [--context <name>]
  keyrail bind [--context <name>]
  keyrail current [--json] [--context <name>]
  keyrail identify [--json]
  keyrail doctor [--json] [--context <name>]
  keyrail projects [--json]
  keyrail link|unlink <service> <reference>
  keyrail profile list|set|unset
  keyrail use <service> [--reference <reference>] -- <command>
  keyrail context list|use|add|remove
  keyrail policy show|preset|allow|allow-last|deny|require-confirm [--] <command>
  keyrail handoff [--json] [--context <name>]
  keyrail secrets list|set|unset [--context <name>]
  keyrail audit list [--json]
`);
}

function titleize(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function ensureLocalKeyrailGitignore(root) {
  const gitignorePath = path.join(root, ".gitignore");
  const entries = [MANIFEST_FILE, ".keyrail/", ".ctx/"];
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = entries.filter((entry) => !existing.has(entry));
  if (!missing.length) return;

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const section = `${current ? "\n" : ""}# Keyrail local agent state\n${missing.join("\n")}\n`;
  await writeFile(gitignorePath, `${current}${prefix}${section}`);
}

async function loadProjectState(startDir = process.cwd()) {
  const root = await findProjectRoot(startDir);
  try {
    return { ...(await loadManifest(root)), source: "manifest" };
  } catch (error) {
    if (error.code !== "MANIFEST_NOT_FOUND") throw error;
  }

  const store = await readProjectStore();
  const key = projectKeyForRoot(root);
  const existing = store.projects[key];
  const manifest = existing?.manifest ? normalizeManifest(existing.manifest) : await createDefaultManifest(root);
  return {
    root,
    path: getProjectStorePath(),
    source: "user",
    key,
    activeContext: existing?.activeContext ?? manifest.project.defaultContext,
    manifest
  };
}

async function writeProjectState(state) {
  if (state.source === "manifest") {
    await writeManifest(state.root, state.manifest);
    return;
  }

  const store = await readProjectStore();
  store.projects[state.key ?? projectKeyForRoot(state.root)] = {
    root: state.root,
    activeContext: state.activeContext ?? state.manifest.project.defaultContext,
    manifest: state.manifest
  };
  await writeProjectStore(store);
}

async function resolveProjectContextName(state, requestedContext = null) {
  if (requestedContext) return requestedContext;
  if (state.source === "user") return state.activeContext ?? state.manifest.project.defaultContext;
  return resolveActiveContextName(state.root, state.manifest, requestedContext);
}

async function writeActiveContext(state, contextName) {
  if (state.source === "manifest") {
    await writeContextLock(state.root, { project: state.manifest.project.id, context: contextName });
    return;
  }

  state.activeContext = contextName;
  await writeProjectState(state);
}

async function createDefaultManifest(root) {
  const identity = await identifyProject(root, null);
  const id = identity.packageName ?? path.basename(root);
  const repo = identity.gitRemote ?? "local";
  return {
    project: { id, name: titleize(id), repo, defaultContext: "local" },
    contexts: {
      local: {
        name: "local",
        risk: "low",
        secrets: {},
        requireConfirmation: false
      }
    },
    policy: {
      allow: ["gh issue list", "vercel deploy", "supabase db push"],
      requireConfirm: ["vercel deploy --prod", "supabase db reset"],
      deny: ["gh repo delete"]
    }
  };
}

function getProjectStorePath() {
  return path.join(getKeyrailConfigRoot(), "projects.json");
}

async function readProjectStore() {
  try {
    const raw = await readFile(getProjectStorePath(), "utf8");
    const store = JSON.parse(raw);
    return { version: 1, projects: {}, ...store, projects: store.projects ?? {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, projects: {} };
    throw error;
  }
}

async function writeProjectStore(store) {
  const storePath = getProjectStorePath();
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function projectKeyForRoot(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function getProfilePath() {
  return path.join(getKeyrailConfigRoot(), "profiles.json");
}

async function readProfile() {
  try {
    const raw = await readFile(getProfilePath(), "utf8");
    const profile = JSON.parse(raw);
    const services = profile.services ?? {};
    const accounts = profile.accounts ?? {};
    for (const [service, entry] of Object.entries(services)) {
      accounts[service] = accounts[service] ?? {};
      if (entry?.reference) accounts[service][entry.reference] = { reference: entry.reference };
    }
    return { version: 1, services, accounts, ...profile, services, accounts };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, services: {}, accounts: {} };
    throw error;
  }
}

async function writeProfile(profilePath, profile) {
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

async function readStdin(options = {}) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))).toString("utf8").trim();
  if (!value && !options.allowEmpty) {
    throw new KeyrailError("EMPTY_SECRET", "Refusing to save empty secret from stdin. Pass --allow-empty if this is intentional.");
  }
  return value;
}

function commandFromPolicyArgs(args, flags, passthrough) {
  if (passthrough.length > 0) return normalizeCommand(passthrough);
  return args.join(" ") || flags.command;
}

async function envForServiceCommand(service, token, command) {
  const envName = envNameForProvider(service);
  const env = { [envName]: token };

  if (service === "github") {
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
    if (command[0] === "git") {
      const askpass = await createGithubAskpass(token);
      env.GIT_ASKPASS = askpass.askpassPath;
      env.GIT_TERMINAL_PROMPT = "0";
      env.KEYRAIL_GITHUB_TOKEN = token;
      env.KEYRAIL_CLEANUP_DIR = askpass.tempDir;
    }
  }

  return env;
}

async function createGithubAskpass(token) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "keyrail-git-"));
  const askpassPath = path.join(tempDir, "askpass.sh");
  await writeFile(
    askpassPath,
    `#!/bin/sh\ncase "$1" in\n*Username*) printf '%s\\n' x-access-token ;;\n*) printf '%s\\n' "$KEYRAIL_GITHUB_TOKEN" ;;\nesac\n`,
    { mode: 0o700 }
  );
  return { tempDir, askpassPath };
}

export async function getStateForUi(root = process.cwd(), requestedContext = null) {
  const loaded = await loadProjectState(root);
  const activeContext = await resolveProjectContextName(loaded, requestedContext ?? undefined);
  const context = getContext(loaded.manifest, activeContext);
  const identity = await identifyProject(loaded.root, loaded.manifest);
  const verification = verifyIdentity(identity, loaded.manifest);
  const backend = createSecretBackend({ type: "local-file", root: loaded.root });
  const secrets = await backend.listReferences(context.secrets);
  const audit = await readAuditLog(loaded);
  const services = secrets.map((secret) => ({
    service: secret.provider,
    reference: secret.reference,
    envName: secret.envName,
    alias: secret.alias,
    configured: secret.configured
  }));
  const vercelEnvSync = buildVercelEnvSyncPanel({
    project: loaded.manifest.project,
    context,
    services,
    vercelProject: loaded.manifest.project.id,
    envTarget: defaultVercelEnvTarget(context.name)
  });
  const policyRepair = buildPolicyRepairState(audit, loaded.manifest.policy);
  return {
    root: loaded.root,
    source: loaded.source,
    project: loaded.manifest.project,
    contexts: Object.values(loaded.manifest.contexts),
    context,
    identity,
    verification,
    secrets,
    services,
    audit,
    policy: loaded.manifest.policy,
    policyRepair,
    vercelEnvSync,
    activeContext
  };
}

async function readAuditLog(state, limit = 50) {
  const auditPath = state.source === "user"
    ? path.join(getKeyrailConfigRoot(), "audit", `${projectKeyForRoot(state.root)}.log`)
    : path.join(state.root, ".keyrail", "audit.log");
  try {
    const raw = await readFile(auditPath, "utf8");
    return raw.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function buildPolicyRepairState(audit, policy) {
  const last = [...(audit ?? [])].reverse().find((entry) => entry.decision === "denied" || entry.decision === "confirmation_required");
  if (!last?.command) return null;
  const deniedBy = (policy.deny ?? []).find((pattern) => last.command.startsWith(pattern));
  return {
    decision: last.decision,
    command: last.command,
    reason: last.reason,
    nextSteps: policyRepairNextSteps(last.command, last.decision, deniedBy)
  };
}

function policyRepairNextSteps(command, decision, deniedBy = null, includeDoctor = false) {
  if (decision === "confirmation_required") {
    const steps = [
      nextStep(`keyrail run --yes -- ${command}`, "Confirm and retry this exact command."),
      nextStep("KEYRAIL_CONFIRM=1 keyrail run -- <command>", "Alternative confirmation form for non-interactive runners."),
      nextStep("keyrail policy allow-last", "Promote this last confirmation-required audit command into require-confirm policy.")
    ];
    if (includeDoctor) steps.push(nextStep("keyrail doctor", "Review identity, context risk, and policy guidance."));
    return steps;
  }
  const steps = [];
  if (includeDoctor) steps.push(nextStep("keyrail doctor", "See policy guidance for common commands in this repo."));
  steps.push(nextStep("keyrail policy allow-last", "Allow the last denied audit command exactly."));
  if (deniedBy) {
    steps.push(nextStep("keyrail policy show --json", `Review explicit deny rule "${deniedBy}" before changing policy.`));
    return steps;
  }
  steps.push(nextStep(`keyrail policy allow -- ${command}`, "Add a narrow allow rule for this command."));
  const provider = providerForCommand(command);
  if (provider === "vercel") steps.push(nextStep("keyrail policy preset vercel", "Apply the common Vercel workflow preset."));
  if (provider === "github") steps.push(nextStep("keyrail policy preset github-read", "Apply read-only GitHub workflow rules."));
  if (/\b(wrangler|cloudflare)\b/i.test(command)) steps.push(nextStep("keyrail policy preset cloudflare-api", "Apply the common Cloudflare API workflow preset."));
  return steps;
}

export async function renderUiHtml(root = process.cwd(), token = "") {
  const state = await getStateForUi(root);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Keyrail</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #f5f7fb; --panel: #ffffff; --border: #d7dbe7; --text: #101828; --muted: #667085; --accent: #2563eb; --ok: #14804a; --warn: #b54708; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header, section { padding: 16px 20px; border-bottom: 1px solid var(--border); }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; background: var(--panel); position: sticky; top: 0; }
    main { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 64px); }
    aside, article { padding: 20px; }
    aside { border-right: 1px solid var(--border); background: #fafbff; }
    button, select, textarea, input { font: inherit; }
    button { border: 1px solid var(--border); background: var(--panel); padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    button.primary { background: var(--accent); color: white; border-color: var(--accent); }
    .stack { display:grid; gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
    .muted { color: var(--muted); font-size: 14px; }
    .contexts { display:flex; flex-wrap:wrap; gap:8px; }
    .context-btn.active { background: #dbeafe; border-color: #93c5fd; }
    textarea { width: 100%; min-height: 280px; border: 1px solid var(--border); border-radius: 10px; padding: 12px; box-sizing: border-box; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .toolbar { display:flex; gap: 8px; flex-wrap: wrap; align-items:center; }
    .tag { display:inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
    .service-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
    .service-row:last-child { border-bottom:0; }
    .status-ok { color: var(--ok); }
    .status-warn { color: var(--warn); }
    code { background:#f2f4f7; padding:2px 6px; border-radius:6px; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <strong>Keyrail</strong>
      <span class="muted">project keys for local agents</span>
    </div>
    <div class="toolbar">
      <button class="primary" onclick="saveManifest()">Save config</button>
      <button onclick="refreshState()">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="stack">
        <div class="card">
          <div class="muted">Project</div>
          <h2 id="project-name">${escapeHtml(state.project.name)}</h2>
          <div class="muted" id="project-id">${escapeHtml(state.project.id)}</div>
          <div class="muted">${state.source === "user" ? "Stored in user Keyrail config" : `Stored in ${MANIFEST_FILE}`}</div>
          <div class="tag" id="verification">${state.verification.reason}</div>
        </div>
        <div class="card">
          <div class="muted">Context</div>
          <div class="contexts" id="context-list"></div>
        </div>
        <div class="card">
          <div class="muted">Services</div>
          <div id="secret-list"></div>
        </div>
      </div>
    </aside>
    <article>
      <div class="split">
        <section class="card">
          <div class="muted">Agent Command</div>
          <p>Run project commands through <code>keyrail run -- &lt;command&gt;</code>.</p>
          <p class="muted">Keyrail verifies this project and injects only the linked service keys for the active context.</p>
        </section>
        <section class="card">
          <div class="muted">Project Config</div>
          <textarea id="manifest-editor"></textarea>
        </section>
        <section class="card">
          <div class="muted">Vercel Env Sync</div>
          <div id="vercel-sync"></div>
        </section>
        <section class="card">
          <div class="muted">Policy Repair</div>
          <div id="policy-repair"></div>
        </section>
        <section class="card">
          <div class="muted">Audit</div>
          <pre id="audit-log"></pre>
        </section>
      </div>
    </article>
  </main>
  <script>
    const state = ${JSON.stringify(state)};
    const editor = document.getElementById('manifest-editor');
    const contextList = document.getElementById('context-list');
    const secretList = document.getElementById('secret-list');
    const vercelSync = document.getElementById('vercel-sync');
    const policyRepair = document.getElementById('policy-repair');
    const auditLog = document.getElementById('audit-log');
    editor.value = ${JSON.stringify(stringifyManifestForEditor(state))};
    render();

    async function refreshState() {
      location.reload();
    }

    async function saveManifest() {
      const manifest = window.__manifestDraft || {};
      await apiFetch('/api/manifest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
      location.reload();
    }

    async function switchContext(name) {
      await apiFetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: name }) });
      location.reload();
    }

    function apiFetch(path, options = {}) {
      const headers = Object.assign({}, options.headers || {}, { 'x-keyrail-token': ${JSON.stringify(token)} });
      return fetch(path, Object.assign({}, options, { headers }));
    }

    function render() {
      contextList.innerHTML = state.contexts.map((context) => '<button class="context-btn' + (context.name === state.activeContext ? ' active' : '') + '" onclick="switchContext(\\'' + escapeJs(context.name) + '\\')">' + escapeHtml(context.name) + '</button>').join('');
      secretList.innerHTML = state.services.length
        ? state.services.map((service) => '<div class="service-row"><div><strong>' + escapeHtml(service.service) + '</strong><div class="muted">' + escapeHtml(service.reference) + ' -> ' + escapeHtml(service.envName) + (service.alias ? ' <span class="tag">alias</span>' : '') + '</div></div><span class="' + (service.configured ? 'status-ok' : 'status-warn') + '">' + (service.configured ? 'Ready' : 'Reference only') + '</span></div>').join('')
        : '<div class="muted">No services attached yet. Use keyrail attach github personal.</div>';
      vercelSync.innerHTML = renderVercelSync(state.vercelEnvSync);
      policyRepair.innerHTML = renderPolicyRepair(state.policyRepair);
      auditLog.textContent = state.audit?.length ? state.audit.map((entry) => JSON.stringify(entry, null, 2)).join('\\n\\n') : 'No audit entries';
      window.__manifestDraft = stateToManifest(state, editor.value);
    }

    function renderVercelSync(panel) {
      if (!panel) return '<div class="muted">No Vercel sync state.</div>';
      const mappings = panel.mappings?.length
        ? panel.mappings.map((mapping) => '<div class="service-row"><div><strong>' + escapeHtml(mapping.envName) + '</strong>' + (mapping.alias ? ' <span class="tag">alias</span>' : '') + '<div class="muted">' + escapeHtml(mapping.service) + ':' + escapeHtml(mapping.reference) + '</div></div><span class="' + (mapping.configured ? 'status-ok' : 'status-warn') + '">' + escapeHtml(mapping.status) + '</span></div>').join('')
        : '<div class="muted">No non-Vercel secrets to sync.</div>';
      return '<div class="stack"><div><strong>Auth:</strong> ' + escapeHtml(panel.auth.envName) + ' <span class="' + (panel.auth.configured ? 'status-ok' : 'status-warn') + '">' + escapeHtml(panel.auth.status) + '</span></div><div class="muted">Target: ' + escapeHtml(panel.envTarget) + ' / project ' + escapeHtml(panel.vercelProject) + '</div>' + mappings + '<div class="muted">Dry-run: <code>' + escapeHtml(panel.dryRunCommand) + '</code></div><div class="muted">' + escapeHtml(panel.note) + '</div></div>';
    }

    function renderPolicyRepair(repair) {
      if (!repair) return '<div class="muted">No denied or confirmation-required command in recent audit.</div>';
      const steps = repair.nextSteps?.length
        ? repair.nextSteps.map((step) => '<li><code>' + escapeHtml(step.command) + '</code><div class="muted">' + escapeHtml(step.reason) + '</div></li>').join('')
        : '';
      return '<div class="stack"><div><strong>' + escapeHtml(repair.decision) + '</strong>: <code>' + escapeHtml(repair.command) + '</code></div>' + (repair.reason ? '<div class="muted">' + escapeHtml(repair.reason) + '</div>' : '') + '<ol>' + steps + '</ol></div>';
    }

    editor.addEventListener('input', () => { window.__manifestDraft = stateToManifest(state, editor.value); });

    function stateToManifest(state, text) {
      try {
        return JSON.parse(text);
      } catch {
      return {
        project: state.project,
        contexts: Object.fromEntries(state.contexts.map((context) => [context.name, context])),
        policy: state.policy
      };
    }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>\\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }

    function escapeJs(value) {
      return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }
  </script>
</body>
</html>`;
}

function stringifyManifestForEditor(state) {
  return JSON.stringify({
    project: state.project,
    contexts: Object.fromEntries(state.contexts.map((context) => [context.name, context])),
    policy: state.policy
  }, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function isUiRequestAuthorized(req, url, token) {
  if (!token) return true;
  const provided = req.headers["x-keyrail-token"] ?? url.searchParams.get("token");
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(token);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function sendUnauthorized(res) {
  send(res, 401, "application/json; charset=utf-8", JSON.stringify({ error: "unauthorized" }));
}

function send(res, statusCode, contentType, body) {
  res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
