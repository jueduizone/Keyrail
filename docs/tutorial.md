# Keyrail Tutorial

This tutorial shows the default Keyrail workflow: attach service accounts to a local project without writing project files, then make agents run commands through Keyrail.

## Goal

You have a project that uses:

- GitHub
- Vercel
- Supabase
- OpenAI

You want a local agent to use this project's keys, not keys from another repo.

## 1. Enter the Project

From the project root:

```bash
cd acme-web
keyrail status --json
```

No `keyrail init` is required. If no Keyrail config exists yet, Keyrail creates an in-memory default from the current Git/package/directory identity. It only writes user-level project routing after you attach a service, change context, or edit policy.

## 2. Optional: Clone a Private Repo First

If the private repo is not on disk yet, save a user-level GitHub account, then run the normal clone command through Keyrail:

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone acme/private-repo
cd private-repo
keyrail attach github personal
keyrail status --json
```

Use `--value-stdin` so the PAT is not part of shell history. The Git remote remains a normal GitHub URL without the token. If `gh` is not available, use `keyrail with github personal -- git clone https://github.com/acme/private-repo.git`.

## 3. Attach Service Accounts

Attach the services this project uses:

```bash
keyrail attach github personal
keyrail attach vercel acme-vercel-token
keyrail attach supabase acme-supabase-token
keyrail attach openai acme-openai-dev
```

These account names are local references. In the default mode they are stored in the user's Keyrail config, not in the project repository.

If you want Keyrail to store a local development value:

```bash
keyrail attach openai acme-openai-dev --value "$OPENAI_API_KEY"
```

In zero-init mode, local values are written to the user-level Keyrail store.

## 4. Check What the Agent Sees

```bash
keyrail status --json
```

The output tells the agent:

- which project it is in
- which services are linked
- which env vars those services map to
- whether each key is configured
- that commands should run through `keyrail run -- <command>`

This is the main agent-friendly integration point.

## 5. Run Commands Through Keyrail

```bash
keyrail run -- gh issue list
keyrail run -- vercel deploy
keyrail run -- supabase db push
```

Keyrail verifies the project, resolves linked keys, injects them into the child process, redacts output, and writes an audit entry.

## 6. Use the Local UI

```bash
keyrail ui
```

Open the printed URL. The UI shows:

- current project
- where project routing is stored
- active context
- linked services
- ready vs account-name-only keys
- the agent command pattern
- project config and audit views

This is the easiest path for non-technical users.

## 7. Common Patterns

Use environment variables instead of local file storage:

```bash
export VERCEL_TOKEN=...
keyrail attach vercel acme-vercel-token
keyrail run -- vercel deploy
```

Remove a service attachment:

```bash
keyrail detach vercel
```

List attached services:

```bash
keyrail status
```

## 8. Advanced: Staging and Production

If a project needs multiple environments:

```bash
keyrail context add staging --risk medium
keyrail context add production --risk high --confirm
keyrail context use staging
```

Link service keys per context:

```bash
keyrail context use production
keyrail attach vercel acme-vercel-prod
```

High-risk contexts require confirmation unless you explicitly pass:

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

## 9. Advanced: Optional Project Manifest

If you explicitly want repo-local Keyrail files for a personal workflow:

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

This creates `.agent-context.yaml` and `.ctx/lock.yaml`. Keyrail adds `.agent-context.yaml`, `.keyrail/`, and `.ctx/` to `.gitignore` when this mode is initialized. The manifest stores account names, not raw secret values.

## 10. Advanced: Policy and Audit

Allow expected commands:

```bash
keyrail policy allow vercel deploy
keyrail policy allow supabase db push
```

Deny dangerous commands:

```bash
keyrail policy deny gh repo delete
```

View recent command decisions:

```bash
keyrail audit list
keyrail audit list --json
```

## 11. Handoff to Another Agent

```bash
keyrail handoff --json
```

The handoff includes project identity, active context, linked services, and policy. It does not include raw secret values.
