# Agent Integration

Keyrail supports agents in an MCP-first model:

1. Prefer official provider MCP tools for provider-native API work.
2. Use Keyrail for local project commands that need project-specific env vars.
3. Skill: lightweight instructions for agents.
4. MCP: future structured Keyrail tools for deeper integration.

The current recommended integration is the skill in:

```text
agents/keyrail/SKILL.md
```

## In an Existing Repository

First classify the work:

- GitHub issues/PRs/repo metadata, Vercel project/deployment logs, Supabase project API, Cloudflare API: use the official provider MCP when available.
- `npm run ...`, `vercel deploy`, `supabase db push`, `curl ...`, deployment scripts, multi-service commands, env aliases, or env sync: use Keyrail.

Agents should start with:

```bash
keyrail status --json
```

Then use this only when local shell execution needs project env routing:

```bash
keyrail run -- <command>
```

For provider-native operations that do not require local shell execution, prefer the official MCP.

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

When a repo does not exist locally yet, save a user-level GitHub account, then run the normal clone command through Keyrail:

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone owner/private-repo
```

This avoids placing the PAT in shell history or the remote URL. After cloning, attach the GitHub account to the local project. No project init is required:

```bash
keyrail attach github personal
keyrail status --json
```

Keyrail stores that project routing in the user's local Keyrail config by default, not in the repository.

## Future Keyrail MCP Tools

Keyrail may also expose its own MCP tools so agents can inspect local routing without memorizing CLI syntax. Planned tools:

- `keyrail.status`
- `keyrail.list_services`
- `keyrail.with`
- `keyrail.run`
- `keyrail.handoff`

The default Keyrail MCP mode should expose read-only tools first. `run` and `with` should require explicit enablement. Official provider MCPs should remain the preferred path for provider-native operations.
