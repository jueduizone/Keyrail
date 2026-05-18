---
name: keyrail
description: Use Keyrail to identify local projects and route project-specific service keys for GitHub, Vercel, Supabase, OpenAI, Anthropic, Stripe, and similar developer services.
---

# Keyrail Agent Skill

Use this skill whenever you are working in a local repository that may need project-specific credentials.

## Repository Already Exists

1. Run:

   ```bash
   keyrail current --json
   ```

2. If the project is verified, use:

   ```bash
   keyrail run -- <command>
   ```

   for GitHub, Vercel, Supabase, OpenAI, Anthropic, Stripe, cloud, and deployment commands.

3. Never read, print, or copy raw secret values.

4. If a service is missing, tell the user:

   ```bash
   keyrail link <service> <reference>
   ```

5. If a key value is not configured, tell the user to configure the referenced key through their chosen backend or:

   ```bash
   keyrail link <service> <reference> --value <secret>
   ```

6. If project identity is not verified, stop and ask the user to run:

   ```bash
   keyrail init
   ```

## Private Repository Not Yet Cloned

If the user asks you to clone a private GitHub repository and normal `git clone` fails or would require a PAT:

1. Check whether a GitHub bootstrap profile exists:

   ```bash
   keyrail profile list
   ```

2. If no GitHub profile exists, ask the user to configure one:

   ```bash
   keyrail profile set github <reference> --value-stdin
   ```

3. Run the normal clone command through Keyrail's service credential environment:

   ```bash
   keyrail use github -- gh repo clone <owner/repo>
   ```

   If `gh` is not available, use:

   ```bash
   keyrail use github -- git clone https://github.com/<owner>/<repo>.git
   ```

4. After the repository is local, initialize and bind the project:

   ```bash
   keyrail init --repo git@github.com:<owner>/<repo>.git
   keyrail link github <reference>
   keyrail current --json
   ```

Keyrail provides the configured GitHub credential to the child process without putting the token in the remote URL.

## Output Rules

- Prefer `--json` for status commands when you need structured data.
- Do not expose raw tokens in logs, markdown, summaries, or commit messages.
- If Keyrail refuses execution, report the refusal and the next setup command.
