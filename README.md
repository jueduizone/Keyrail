# Keyrail

**Agent-aware project identity and credential routing for local development.**

[中文文档](README.zh-CN.md) · [Tutorial](docs/tutorial.md) · [中文教程](docs/tutorial.zh-CN.md)

Keyrail helps developers and coding agents work across many local projects without mixing identities, accounts, or credentials. It binds a repository to an explicit project manifest, verifies the active context, resolves secret references through a pluggable backend, and runs commands through a policy gate.

## Why Keyrail

Modern local development often spans many projects and many identities:

- one laptop, many repos
- different GitHub, Vercel, Supabase, Stripe, OpenAI, or Anthropic credentials per project
- coding agents that may not know which project, account, or environment they are operating in
- production commands that should never run by accident

Secret managers store secrets. Keyrail sits above them as the identity and routing layer: it tells the agent which project it is in, which context is active, which secret references are allowed, and which commands are safe to run.

## Features

- Project identity manifest: `.agent-context.yaml`
- Active context lock: `.ctx/lock.yaml`
- Git remote and package identity detection
- Context-aware secret references
- Local file and environment secret backends
- Policy-gated command wrapper
- High-risk context confirmation
- Audit log without raw secrets
- Local browser UI for switching contexts and editing the manifest
- JSON-friendly CLI output for agents

## Install

From the repository:

```bash
npm install
npm run keyrail -- current
```

Package entry point:

```bash
npx @keyrail/cli current
```

When published to npm:

```bash
npm i -D @keyrail/cli
npx keyrail init
```

## Quick Start

Initialize Keyrail in a repository:

```bash
keyrail init --id acme-web --name "Acme Web" --repo local
```

Check the current verified context:

```bash
keyrail current
keyrail doctor
```

Add a staging context and switch to it:

```bash
keyrail context add staging --risk medium
keyrail context use staging
```

Add a secret reference:

```bash
keyrail secrets set openai acme-openai-dev
```

Run a provider command through Keyrail:

```bash
keyrail policy allow gh issue list
keyrail run -- gh issue list
```

Open the local UI:

```bash
keyrail ui
```

The UI binds to `127.0.0.1` by default and prints a one-time URL with an access token.

## Manifest

Keyrail reads `.agent-context.yaml` from the project root.

```yaml
project:
  id: acme-web
  name: Acme Web
  repo: git@github.com:acme/web.git
  default_context: staging

contexts:
  local:
    risk: low
    secrets:
      openai: acme-openai-dev

  staging:
    risk: medium
    secrets:
      github: acme-github-limited
      vercel: acme-vercel-staging

  production:
    risk: high
    require_confirmation: true
    secrets:
      github: acme-github-release
      vercel: acme-vercel-prod

policy:
  allow:
    - gh issue list
    - vercel deploy
  require_confirm:
    - vercel deploy --prod
  deny:
    - gh repo delete
```

The manifest stores references, not raw secret values.

## Commands

```bash
keyrail init [--id <id>] [--name <name>] [--repo <url|local>] [--context <name>]
keyrail bind [--context <name>]
keyrail current [--json] [--context <name>]
keyrail identify [--json]
keyrail doctor [--json]
keyrail run [--context <name>] [--yes] -- <command>
keyrail context list|use|add|remove
keyrail policy show|allow|deny|require-confirm
keyrail secrets list|set|unset [--context <name>]
keyrail audit list [--json]
keyrail handoff [--json]
keyrail ui [--port <port>] [--token <token>]
```

## Local UI

`keyrail ui` starts a local manager for:

- viewing project identity
- switching active contexts
- editing the manifest
- reviewing secret references
- viewing audit history

It is intentionally local-first. The UI is protected by a token printed in the startup URL.

## Secret Backends

Keyrail does not force a specific vault. The current release includes:

- `local-file`: `.keyrail/secrets.local.json`
- `env`: process environment variables such as `OPENAI_API_KEY`

Future adapters can be added for 1Password, Infisical, macOS Keychain, Vault, or other systems without changing the manifest model.

## Security Model

- Raw secret values are never printed by normal commands.
- Secret values are injected only into child processes.
- Command output is redacted before it is printed.
- Project identity is verified before command execution.
- High-risk contexts require explicit confirmation.
- Audit logs record decisions and references, not raw secret values.
- If identity cannot be verified, Keyrail fails closed.

## Development

```bash
npm install
npm run check
npm_config_cache=/private/tmp/keyrail-npm-cache npm run pack:dry-run
```

The repository is a Node.js workspace:

```text
packages/
  cli/
  core/
  backends/
  policy/
```

## Release Status

Current version: `0.1.0`.

The package is prepared for public npm publishing, but publishing requires npm account access.
