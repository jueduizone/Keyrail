# Keyrail

Agent-aware project identity and credential routing for local development.

Keyrail binds a repository to an explicit project manifest, verifies the active context, resolves secret references through a pluggable backend, and runs provider commands through a policy gate.

## Quick Start

```bash
npm install
npm run keyrail -- init
npm run keyrail -- current
npm run keyrail -- run -- gh issue list
npm run keyrail -- ui
```

The MVP defaults to a local development backend. Normal commands print references and redacted values, not raw secrets.

## Commands

```bash
keyrail init
keyrail bind
keyrail current [--json]
keyrail identify [--json]
keyrail doctor [--json]
keyrail run [--context <name>] -- <command>
keyrail context list|use|add|remove
keyrail policy show|allow|deny|require-confirm
keyrail handoff [--json]
keyrail secrets list|set|unset [--json]
keyrail audit list [--json]
keyrail ui [--port <port>] [--token <token>]
```

## Manifest

Keyrail reads `.agent-context.yaml` from the project root. It contains project identity, contexts, secret references, and command policy.

`keyrail ui` opens a local browser-based manager for switching contexts, editing the manifest, reviewing secrets, and viewing audit history.

The UI binds to `127.0.0.1` by default and prints a one-time access URL with a token. API requests must include that token.

## Release Readiness

The npm package entry point is `@keyrail/cli`. Before publishing, run:

```bash
npm run check
npm run pack:dry-run
```

See [examples/agent-context.yaml](/Users/IanX/Documents/Keyrail/examples/agent-context.yaml).
