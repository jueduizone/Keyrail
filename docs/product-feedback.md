# Keyrail Product Feedback

This document captures real usage feedback from a deployment workflow that needed GitHub, Vercel, Cloudflare Stream, and project-specific environment variables.

## Core Problems

### 1. Multiple Secrets Need One Child Process

Current workaround:

```bash
ACCOUNT_ID=$(keyrail use cloudflare-stream-account-id -- printenv KEYRAIL_CLOUDFLARE_STREAM_ACCOUNT_ID)
```

This is awkward and unsafe as a machine interface because Keyrail correctly redacts stdout. Scripts should not pass secrets through stdout.

Target direction:

```bash
keyrail use vercel cloudflare-stream-api-token cloudflare-stream-account-id -- <command>
keyrail run --with vercel,cloudflare-stream-api-token,cloudflare-stream-account-id -- <command>
```

The important product rule: Keyrail should inject all required values into the same child process instead of making users compose secrets through shell output.

Progress: implemented `keyrail run --with <service-or-ref>[,<service-or-ref>...] -- <command>`. It injects attached project secrets plus explicitly requested saved service accounts or references into one child process, includes injected/missing env names in dry-run and audit output, and preserves redaction of raw secret values.

### 2. Env Aliases

Custom providers currently map to names such as:

```text
KEYRAIL_CLOUDFLARE_STREAM_API_TOKEN
```

Applications and deploy platforms often expect:

```text
CLOUDFLARE_STREAM_API_TOKEN
```

Target direction:

```bash
keyrail attach cloudflare-stream-api-token soloship/cloudflare-stream-api-token --env CLOUDFLARE_STREAM_API_TOKEN
```

Routing should store both the service reference and the target env name. Status output should show the alias explicitly.

Progress: implemented `keyrail attach <service> <name> --env <ENV_NAME>`. Project routing stores `{ reference, envName }` without raw values, while legacy `context.secrets` string references remain valid. Status, doctor, run dry-run, UI state, UI service rows, and audit output expose the alias metadata.

### 3. First-Class Vercel Env Sync

Common workflow: Keyrail stores local/project secrets, but the deployment platform also needs env vars.

Manual workaround:

```bash
printf value | npx vercel env add CLOUDFLARE_STREAM_API_TOKEN production
```

Target direction:

```bash
keyrail sync vercel-env CLOUDFLARE_STREAM_API_TOKEN --from cloudflare-stream-api-token --target production
```

This should avoid printing raw values, redact subprocess output, and ideally support dry-run/audit.

Progress: implemented `keyrail sync vercel-env`. It resolves current project secrets, excludes the attached `vercel` token from the sync payload, writes values to `vercel env add` through stdin, supports `--dry-run`, `--json`, `--target`, `--project`, and `--yes`, redacts child-process output, and audits synced/missing/failed env names. Default Vercel target maps `local/dev/development` to `development`, `prod/production` to `production`, and `preview/staging` to `preview`. `status --json` and the local UI now expose a Vercel env sync panel with auth status, target, mappings, alias flags, and a copyable dry-run command.

## Policy UX

### Complex Commands

`keyrail run -- /bin/zsh -lc '...'` is currently hard to allow because policy matching compares normalized command prefixes and rejects shell control tokens when they are passed as separate argv tokens. Real deployment flows often include `export`, pipes, variable references, curl headers, and deploy CLI commands.

Implemented directions:

- `keyrail policy preset vercel` adds Vercel deploy/env inspection and keeps production env sync confirmation-gated.
- `keyrail policy preset cloudflare-api` allows common Wrangler/API calls while denying destructive Cloudflare deletion commands.
- `keyrail policy preset github-read` allows read-only GitHub/git discovery and keeps destructive repo operations denied.
- `keyrail run` remediation, `status --json`, and the UI now recommend exact narrow allows, `allow-last`, or a relevant preset after denied audit entries.

Still a future direction: host-aware/network-aware policy beyond string prefix matching.

### Safer Policy Entry

Shell metacharacters are easy to accidentally execute before Keyrail sees them:

```bash
keyrail policy allow /bin/zsh -lc printf ... | npx vercel env add ...
```

Implemented quick fix:

```bash
keyrail policy allow -- "/bin/zsh -lc ..."
```

Implemented follow-up:

```bash
keyrail policy allow-last
```

`allow-last` reads the last denied or confirmation-required audit entry for the current project, adds the exact normalized command to `allow` or `requireConfirm`, refuses to override explicit deny rules, and supports `--json`.

## Run vs Use Mental Model

Current split:

- `keyrail run`: project routing + policy + audit
- `keyrail use`: user profile account injection, no project policy

Recommended documentation language:

- Inside a project, prefer `keyrail run`.
- For one-off single-account commands, use `keyrail use` or `keyrail with`.
- For multi-service commands, Keyrail needs one official path, likely `keyrail run --with ... -- <command>`.

## Stdin Safety

`--value-stdin` should never silently save an empty value. Implemented quick fix:

```text
Refusing to save empty secret from stdin. Pass --allow-empty if this is intentional.
```

## Priority

P0:

- Inject multiple named secrets into one child process. Implemented.
- Support env aliases on project attachments. Implemented.
- Provide a safe Vercel env sync workflow. Implemented.

P1:

- Improve policy presets for deployment and API workflows. Implemented with `vercel`, `cloudflare-api`, and `github-read` presets.
- Add `policy allow-last`. Implemented.
- Clarify `run` vs `use` in CLI help and docs. Implemented.

P2:

- UI support for env aliases and Vercel sync mappings. Implemented.
- Guided repair when a command is denied by policy. Implemented in stderr `nextSteps`, `status --json`, and UI policy repair.
