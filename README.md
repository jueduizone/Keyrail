# Keyrail

**Make local agents use the right keys for the right project.**

[中文文档](README.zh-CN.md) · [Tutorial](docs/tutorial.md) · [中文教程](docs/tutorial.zh-CN.md) · [Product feedback](docs/product-feedback.md)

Keyrail is a local credential router for coding agents. If one machine has many projects, and each project uses different GitHub, Vercel, Supabase, OpenAI, Anthropic, Stripe, or other service keys, Keyrail gives agents one simple rule:

> Identify the current local project, then use only the service accounts attached to that project.

Keyrail is not a full secret manager. It is the local routing layer between a repo, named service accounts, and the commands an agent runs.

## Simple Flow

No project init is required by default. Keyrail stores project routing in the user's Keyrail config, not in the repo.

```bash
cd my-project

keyrail auth add github personal --value-stdin
keyrail attach github personal
keyrail attach vercel my-project-vercel
keyrail attach supabase my-project-supabase

keyrail status --json
keyrail run --dry-run -- vercel deploy
keyrail deploy vercel
```

For a beginner-friendly local manager:

```bash
keyrail ui
```

The UI shows the current project, linked services, whether each key is configured, recent audit entries, and the command agents should use: `keyrail run -- <command>`.

## Why This Exists

Agents are good at coding, but local credential context is often ambiguous:

- one machine has many repos
- each repo may use a different GitHub account or token
- one project may deploy to a different Vercel team
- Supabase, Stripe, OpenAI, and Anthropic keys differ per project
- an agent can accidentally use the wrong credential if it only guesses from the shell environment

Keyrail removes that ambiguity without requiring every repo collaborator to use Keyrail.

## What Keyrail Does

- Detects the current project from Git/package/local directory signals.
- Stores project-to-account routing in local user config by default.
- Shows linked services such as GitHub, Vercel, Supabase, OpenAI, and Stripe.
- Resolves named service accounts from user-level storage, project-local storage, or environment variables.
- Injects keys only into the child process launched by `keyrail run`.
- Redacts command output.
- Gives agents structured context through `status --json`.
- Provides a local UI for non-technical users.

## Install

From this repository:

```bash
npm install
npm run keyrail -- status
```

After npm publishing:

```bash
npm i -D @keyrail/cli
npx keyrail status
```

## Main Commands

Save a user-level service account:

```bash
keyrail auth add github personal --value-stdin
keyrail auth add vercel acme-vercel --value-stdin
```

Attach account names to the current project:

```bash
keyrail attach github personal
keyrail attach vercel acme-vercel
keyrail attach supabase acme-supabase
keyrail attach cloudflare-stream-api-token acme-cloudflare --env CLOUDFLARE_STREAM_API_TOKEN
```

If only one saved account exists for a service, `keyrail attach <service>` uses it automatically. If more than one exists, Keyrail prints the default account and candidates so the reference is explicit.

`--env <ENV_NAME>` stores a project/context alias for the injected environment variable name. Keyrail stores only the service reference and target env name in project routing; raw secret values stay in the configured secret backend.

You can also attach and store a local value in one step:

```bash
keyrail attach openai acme-openai-dev --value "$OPENAI_API_KEY"
```

Show the current project in an agent-friendly format:

```bash
keyrail status --json
```

Run commands with the project's linked keys:

```bash
keyrail run --dry-run -- vercel deploy
keyrail run -- gh issue list
keyrail run -- vercel deploy
keyrail run -- supabase db push
keyrail run --with stripe,cloudflare-stream-api-token -- npm run deploy
keyrail deploy vercel --prod --yes
keyrail sync vercel-env --dry-run --target preview --project acme-web
```

`keyrail run --with <service-or-ref>[,<service-or-ref>...] -- <command>` injects the active project's attached services plus extra named service accounts or references into one child process. Dry-run JSON and human output list injected and missing env var names, including aliases, without printing raw secret values.

Open the local UI:

```bash
keyrail ui
```

## Private Repo Bootstrap

If a private repository is not cloned yet, save a user-level GitHub account first, then let the agent run the normal GitHub command through Keyrail:

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone owner/private-repo
cd private-repo
keyrail attach github personal
keyrail status --json
```

Paste the PAT into stdin when prompted by your shell or pipe it from your own secure source. `keyrail with github ... -- ...` injects `GITHUB_TOKEN`/`GH_TOKEN` for the child command. For plain `git clone https://...`, it also uses a temporary Git askpass helper so the token is not written into the Git remote URL.

After the repository exists locally, agents should use the normal project flow:

```bash
keyrail status --json
keyrail run -- gh repo view
```

## Agent Integration

Tell agents to start with:

```bash
keyrail status --json
```

The response includes project identity, active context, linked services, env var names, configured/missing status, suggestions for relevant saved accounts that are not attached yet, and the instruction to use `keyrail run -- <command>`.

Example:

```json
{
  "project": {
    "id": "acme-web",
    "name": "Acme Web"
  },
  "services": [
    {
      "service": "vercel",
      "reference": "acme-vercel-token",
      "envName": "VERCEL_TOKEN",
      "alias": false,
      "configured": true,
      "state": "configured"
    }
  ],
  "deployment": {
    "project": {
      "id": "acme-web",
      "name": "Acme Web",
      "root": "/path/to/acme-web"
    },
    "context": {
      "name": "local",
      "risk": "low",
      "requireConfirmation": false
    },
    "ready": true,
    "missingCount": 0,
    "nextCommand": "keyrail deploy vercel --dry-run"
  },
  "agent": {
    "verified": true,
    "instruction": "Use keyrail run -- <command> so this project receives only its linked service keys."
  }
}
```

Use `keyrail run --dry-run -- <command>` before deploys to see policy results, injected env var names, and missing references without executing the child command. `keyrail deploy vercel [--prod] [--yes] [--dry-run]` is an alias for the Vercel deploy workflow and requires `VERCEL_TOKEN` to be attached and configured. `--yes` confirms Keyrail policy and is forwarded to Vercel.

`keyrail sync vercel-env` copies resolved project secrets (except the attached `vercel` token used only for authentication) to Vercel using `vercel env add <ENV_NAME> <target> --project <project>`. When `--target` is omitted, Keyrail maps `local/dev/development` to `development`, `prod/production` to `production`, and `preview/staging` to `preview`. Use `--dry-run` to inspect env names without writing, `--json` for machine-readable output, `--target <production|preview|development|...>` to choose the Vercel environment, `--project <name>` to override the default project id, and `--yes` to forward confirmation to Vercel. Keyrail redacts secret values from Vercel subprocess output and audits synced, missing, and failed env names without storing raw values.

## Local UI

`keyrail ui` starts a local browser manager for users who do not want to edit JSON or YAML.

It shows:

- current project
- where routing is stored
- active context
- linked services
- ready vs account-name-only keys
- agent command guidance
- project config and audit views

The UI binds to `127.0.0.1` and prints a tokenized URL.

## Storage Model

Default mode is zero-intrusion:

- no `keyrail init` required
- no `.agent-context.yaml` written to the project
- no `.ctx/` written to the project
- no `.keyrail/` written to the project
- project routing is stored under the user's Keyrail config, keyed by local project path

This keeps Keyrail local-private and avoids assuming collaborators also use Keyrail.

## Optional Project Manifest

For advanced local workflows, `keyrail init` writes `.agent-context.yaml` and `.ctx/lock.yaml`. Keyrail now adds `.agent-context.yaml`, `.keyrail/`, and `.ctx/` to `.gitignore` when you explicitly initialize this mode.

The manifest stores account names, not raw secret values.

## Secret Values

Keyrail currently supports:

- user-level local storage through `keyrail auth add`
- project-local development files when explicit manifest mode is used
- environment variables such as `VERCEL_TOKEN`, `GITHUB_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `OPENAI_API_KEY`

Future adapters can support 1Password, Infisical, macOS Keychain, Vault, or other secret stores. They are optional adapters, not required for the core workflow.

## Advanced Commands

These exist for teams that need staging/production, command policy, and audit history:

```bash
keyrail context list|use|add|remove
keyrail policy show|allow|deny|require-confirm
keyrail secrets list|set|unset
keyrail audit list --json
keyrail handoff --json
keyrail doctor
```

`keyrail doctor --json` is the troubleshooting interface for agents and scripts. It keeps the existing status fields compatible and adds `checks`, linked-service readiness, local account attachment suggestions, command-policy guidance, and a structured `nextSteps` array. The human output prints the same remediation commands without exposing raw secret values.

For complex commands, prefer passing the full policy pattern after `--` so the shell does not treat pipes or redirects as part of the outer command:

```bash
keyrail policy allow -- "/bin/zsh -lc 'printf ... | npx vercel env add ...'"
```

## Troubleshooting

Use `keyrail doctor` for a human checklist or `keyrail doctor --json` for structured `checks` and `nextSteps`. Common errors and fixes:

- `POLICY_DENIED`: run `keyrail doctor`, then either route the command through Keyrail (`keyrail run --dry-run -- <command>`) or add a narrow rule with `keyrail policy allow -- <command>`.
- `CONFIRMATION_REQUIRED`: retry after verifying the project/context with `--yes` or `KEYRAIL_CONFIRM=1`, for example `keyrail deploy vercel --prod --yes`.
- `IDENTITY_MISMATCH`: inspect `keyrail status --json` and update the project binding before attaching credentials to the wrong repo or package.
- `SECRET_NOT_FOUND`: store the expected env var value from stdin, for example `keyrail auth add openai <name> --value-stdin`, then attach it with `keyrail attach <service> <name>`.
- embedded credentials in Git remote: remove tokens from the remote URL and use `keyrail with github <name> -- git clone https://github.com/<owner>/<repo>.git` or `keyrail with github <name> -- git push`.
- GitHub 403 or wrong account: check which GitHub account is attached with `keyrail status --json`, then use `keyrail with github <name> -- git push` or save the intended account with `keyrail auth add github <name> --value-stdin`.

## Development

```bash
npm install
npm run check
npm run smoke
npm run release:check
```

`npm run smoke` creates temporary project and Keyrail home directories, uses the local CLI with dummy values, and exercises auth, attach, `status --json`, `doctor --json`, dry-run injection/missing-service reporting, Vercel remediation, GitHub policy denial remediation, and Supabase missing-value remediation. It does not require external network access or real secrets.

`npm run release:check` runs `check`, `smoke`, `npm pack --dry-run`, inspects a real temporary CLI package tarball for the expected `bin`, `src`, `package.json`, and `README.md` files, rejects obvious secret/local-state files, and verifies the unpacked `keyrail` bin can print help. It does not bump versions, publish, or require production credentials.

Current version: `0.1.0`.
