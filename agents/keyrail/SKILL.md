---
name: keyrail
description: Use Keyrail to identify local projects and route project-specific service keys for GitHub, Vercel, Supabase, OpenAI, Anthropic, Stripe, and similar developer services.
---

# Keyrail Agent Skill

Use this skill whenever you are working in a local repository that may need project-specific credentials.

## Repository Already Exists

1. Run:

   ```bash
   keyrail status --json
   ```

2. If the project is verified, use:

   ```bash
   keyrail run -- <command>
   ```

   for GitHub, Vercel, Supabase, OpenAI, Anthropic, Stripe, cloud, and deployment commands.

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

6. If project identity is not verified, stop and ask the user to run:

   ```bash
   keyrail init
   ```

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

4. After the repository is local, initialize and bind the project:

   ```bash
   keyrail init --repo git@github.com:<owner>/<repo>.git
   keyrail attach github <name>
   keyrail status --json
   ```

Keyrail provides the configured GitHub credential to the child process without putting the token in the remote URL.

## Output Rules

- Prefer `--json` for status commands when you need structured data.
- Do not expose raw tokens in logs, markdown, summaries, or commit messages.
- If Keyrail refuses execution, report the refusal and the next setup command.
