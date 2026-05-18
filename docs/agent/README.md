# Agent Integration

Keyrail supports agents in two layers:

1. Skill: lightweight instructions for agents.
2. MCP: future structured tools for deeper integration.

The current recommended integration is the skill in:

```text
agents/keyrail/SKILL.md
```

## In an Existing Repository

Agents should start with:

```bash
keyrail current --json
```

Then use:

```bash
keyrail run -- <command>
```

for service commands.

## Before a Private Repository Is Cloned

When a repo does not exist locally yet, project-level Keyrail manifests are not available. Use a user-level bootstrap profile:

```bash
keyrail profile set github personal-github --value-stdin
keyrail clone github owner/private-repo
```

This avoids placing the PAT in shell history or the remote URL.

## Future MCP Tools

Planned tools:

- `keyrail.current`
- `keyrail.list_services`
- `keyrail.clone`
- `keyrail.run`
- `keyrail.handoff`

The default MCP mode should expose read-only tools first. `run` and `clone` should require explicit enablement.
