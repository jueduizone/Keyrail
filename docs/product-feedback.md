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

## Policy UX

### Complex Commands

`keyrail run -- /bin/zsh -lc '...'` is currently hard to allow because policy matching compares normalized command prefixes and rejects shell control tokens when they are passed as separate argv tokens. Real deployment flows often include `export`, pipes, variable references, curl headers, and deploy CLI commands.

Target directions:

- Add policy presets for common safe operations:

  ```text
  allow vercel env add
  allow curl api.cloudflare.com
  allow npm run <script>
  ```

- Add host-aware/network-aware presets rather than requiring full shell strings.
- Prefer structured sync commands for common deploy flows so users do not need to allow arbitrary shell wrappers.

### Safer Policy Entry

Shell metacharacters are easy to accidentally execute before Keyrail sees them:

```bash
keyrail policy allow /bin/zsh -lc printf ... | npx vercel env add ...
```

Implemented quick fix:

```bash
keyrail policy allow -- "/bin/zsh -lc ..."
```

Future improvement:

```bash
keyrail policy allow-last
```

`allow-last` should read the last denied audit entry for the current project/context, show the exact normalized command, and require confirmation before adding it.

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

- Inject multiple named secrets into one child process.
- Support env aliases on project attachments.
- Provide a safe Vercel env sync workflow.

P1:

- Improve policy presets for deployment and API workflows.
- Add `policy allow-last`.
- Clarify `run` vs `use` in CLI help and docs.

P2:

- UI support for env aliases and Vercel sync mappings.
- Guided repair when a command is denied by policy.
