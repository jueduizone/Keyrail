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
keyrail status --json
```

Then use:

```bash
keyrail run -- <command>
```

for service commands.

If `status --json` shows that a needed service is missing, agents should check saved accounts:

```bash
keyrail auth list --json
```

If the right account exists, attach it with user confirmation:

```bash
keyrail attach <service> <name>
```

If no account exists, ask the user to add one with `--value-stdin` rather than pasting raw tokens into chat.

## Before a Private Repository Is Cloned

When a repo does not exist locally yet, project-level Keyrail manifests are not available. Save a user-level GitHub account, then run the normal clone command through Keyrail:

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone owner/private-repo
```

This avoids placing the PAT in shell history or the remote URL. After cloning, initialize the project and attach the GitHub account:

```bash
keyrail init --repo git@github.com:owner/private-repo.git
keyrail attach github personal
keyrail status --json
```

## Future MCP Tools

Planned tools:

- `keyrail.status`
- `keyrail.list_services`
- `keyrail.with`
- `keyrail.run`
- `keyrail.handoff`

The default MCP mode should expose read-only tools first. `run` and `with` should require explicit enablement.
