# Keyrail

**Make local agents use the right keys for the right project.**

[中文文档](README.zh-CN.md) · [Tutorial](docs/tutorial.md) · [中文教程](docs/tutorial.zh-CN.md)

Keyrail is a local project credential router for coding agents. If you have many local projects and each project uses different GitHub, Vercel, Supabase, OpenAI, Anthropic, or Stripe keys, Keyrail gives the agent a simple rule:

> First identify the current project. Then use only the keys linked to that project.

It is not a full secret manager. It is the local layer that binds a repo to service credentials and injects the right values when a command runs.

## The Simple Flow

```bash
cd my-project

keyrail init
keyrail link github my-project-github-token
keyrail link vercel my-project-vercel-token
keyrail link supabase my-project-supabase-token

keyrail current --json
keyrail run -- vercel deploy
```

For a beginner-friendly view:

```bash
keyrail ui
```

The UI shows the current project, linked services, whether each key is configured, and the command agents should use: `keyrail run -- <command>`.

## Why This Exists

Agents are good at coding, but local machines are messy:

- one machine has many repos
- each repo may use a different GitHub account or token
- one project may deploy to a different Vercel team
- Supabase, Stripe, OpenAI, and Anthropic keys differ per project
- an agent can accidentally use the wrong credential if the environment is ambiguous

Keyrail removes that ambiguity.

## What Keyrail Does

- Detects the current project.
- Reads the project identity from `.agent-context.yaml`.
- Shows linked services such as GitHub, Vercel, Supabase, OpenAI, and Stripe.
- Resolves key references from a local backend or environment variables.
- Injects keys only into the child process launched by `keyrail run`.
- Redacts command output.
- Gives agents JSON output through `current --json`.
- Provides a local UI for non-technical users.

## Install

From this repository:

```bash
npm install
npm run keyrail -- current
```

After npm publishing:

```bash
npm i -D @keyrail/cli
npx keyrail init
```

## Main Commands

Initialize a project:

```bash
keyrail init
```

Link a service key reference:

```bash
keyrail link github acme-github-token
keyrail link vercel acme-vercel-token
keyrail link supabase acme-supabase-token
```

Optionally store a local development value:

```bash
keyrail link openai acme-openai-dev --value "$OPENAI_API_KEY"
```

Show the current project in an agent-friendly format:

```bash
keyrail current --json
```

Run commands with the project’s linked keys:

```bash
keyrail run -- gh issue list
keyrail run -- vercel deploy
keyrail run -- supabase db push
```

Open the local UI:

```bash
keyrail ui
```

## Agent Integration

Tell agents to start with:

```bash
keyrail current --json
```

The response includes:

- project id and name
- verified identity signals
- active context
- linked services
- env var names
- whether each key is configured
- the instruction to use `keyrail run -- <command>`

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
      "configured": true
    }
  ],
  "agent": {
    "verified": true,
    "instruction": "Use keyrail run -- <command> so this project receives only its linked service keys."
  }
}
```

## Local UI

`keyrail ui` starts a local browser manager for users who do not want to edit YAML.

It shows:

- current project
- active context
- linked services
- ready vs reference-only keys
- agent command guidance
- advanced manifest and audit views

The UI binds to `127.0.0.1` and prints a tokenized URL.

## Manifest

Keyrail stores project routing in `.agent-context.yaml`.

```yaml
project:
  id: acme-web
  name: Acme Web
  repo: local
  default_context: local

contexts:
  local:
    risk: low
    secrets:
      github: acme-github-token
      vercel: acme-vercel-token
      supabase: acme-supabase-token
      openai: acme-openai-dev

policy:
  allow:
    - gh issue list
    - vercel deploy
    - supabase db push
  require_confirm:
    - vercel deploy --prod
  deny:
    - gh repo delete
```

The manifest stores references, not raw secret values.

## Secret Values

Keyrail currently supports:

- local development file: `.keyrail/secrets.local.json`
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

## Development

```bash
npm install
npm run check
npm_config_cache=/private/tmp/keyrail-npm-cache npm run pack:dry-run
```

## Status

Current version: `0.1.0`.

The repository is ready for npm publishing once package ownership and npm credentials are configured.
