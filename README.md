# Keyrail

Agent-aware project identity and credential routing for local development.

Keyrail binds a repository to an explicit project manifest, verifies the active context, resolves secret references through a pluggable backend, and runs provider commands through a policy gate.

## Quick Start

```bash
npm install
npm run keyrail -- init
npm run keyrail -- current
npm run keyrail -- run -- gh issue list
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
keyrail handoff [--json]
keyrail secrets list [--json]
keyrail ui [--port <port>]
```

## Manifest

Keyrail reads `.agent-context.yaml` from the project root. It contains project identity, contexts, secret references, and command policy.

`keyrail ui` opens a local browser-based manager for switching contexts, editing the manifest, reviewing secrets, and viewing audit history.

See [examples/agent-context.yaml](/Users/IanX/Documents/Keyrail/examples/agent-context.yaml).
