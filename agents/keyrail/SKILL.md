---
name: keyrail
description: Use Keyrail for MCP-first local project credential routing: prefer official provider MCP tools for provider-native API work, and use Keyrail when local project commands need project-specific env vars, multi-service injection, env aliases, or deployment env sync.
---

# Keyrail Agent Skill

Use this skill whenever you are working in a local repository that may need project-specific credentials for local commands. Prefer official provider MCP tools for provider-native API work whenever they are available.

## MCP-First Rule

Before using Keyrail, classify the task:

- Use official provider MCP tools for provider-native API work: GitHub issues/PRs/repo metadata, Vercel project/deployment metadata and logs, Supabase project/database API operations, Cloudflare API operations, and similar structured service actions.
- Use Keyrail for local project commands that need env vars: `npm run ...`, `vercel deploy`, `supabase db push`, `curl ...`, scripts that combine multiple services, env aliases, and syncing local secrets into deployment env stores.
- Do not use Keyrail merely to obtain a provider token when a safe official MCP can perform the operation directly.

## Repository Already Exists

1. Run:

   ```bash
   keyrail status --json
   ```

2. If the project is verified and the task requires local shell execution, use:

   ```bash
   keyrail run -- <command>
   ```

   for project commands that read env vars or need multiple service credentials in one child process.

   If the task is provider-native and an official MCP is available, use that MCP instead.

3. Never read, print, or copy raw secret values.

4. If a required service is missing from `status --json`, inspect saved local accounts:

   ```bash
   keyrail auth list --json
   ```

   If an appropriate account exists, ask before attaching it to the project:

   ```bash
   keyrail attach <service> <name>
   ```

5. If no appropriate account exists or a key value is not configured, ask the user to add the account through Keyrail or their chosen backend. Prefer stdin for raw tokens:

   ```bash
   keyrail auth add <service> <name> --value-stdin
   ```

   For project-local values, the user can also run:

   ```bash
   keyrail attach <service> <name> --value <secret>
   ```

6. If project identity is not verified, do not ask for raw secrets. Report the mismatch and ask the user which local project/account binding should be used. `keyrail status --json` works without project init, and `keyrail attach <service> <name>` stores routing in the user's local Keyrail config by default.

## Private Repository Not Yet Cloned

If the user asks you to clone a private GitHub repository and normal `git clone` fails or would require a PAT:

1. Check whether a GitHub account exists:

   ```bash
   keyrail auth list
   ```

2. If no GitHub account exists, ask the user to configure one. Do not ask them to paste a token into chat:

   ```bash
   keyrail auth add github <name> --value-stdin
   ```

3. Run the normal clone command through Keyrail's service credential environment:

   ```bash
   keyrail with github <name> -- gh repo clone <owner/repo>
   ```

   If `gh` is not available, use:

   ```bash
   keyrail with github <name> -- git clone https://github.com/<owner>/<repo>.git
   ```

4. After the repository is local, attach the GitHub account to that local project:

   ```bash
   keyrail attach github <name>
   keyrail status --json
   ```

Keyrail provides the configured GitHub credential to the child process without putting the token in the remote URL. The project binding is stored in the user's local Keyrail config by default; do not create repo files unless the user explicitly asks for manifest mode.

## Output Rules

- Prefer `--json` for status commands when you need structured data.
- Do not expose raw tokens in logs, markdown, summaries, or commit messages.
- If Keyrail refuses execution, report the refusal and the next setup command.
