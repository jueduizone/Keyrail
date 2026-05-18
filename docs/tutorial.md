# Keyrail Tutorial

This tutorial shows the simplest Keyrail workflow: link service keys to a local project, then make agents run commands through Keyrail.

## Goal

You have a project that uses:

- GitHub
- Vercel
- Supabase
- OpenAI

You want a local agent to use this project’s keys, not keys from another repo.

## 1. Initialize Keyrail

From the project root:

```bash
keyrail init
```

This creates:

```text
.agent-context.yaml
.ctx/lock.yaml
```

For a real GitHub repository, bind the remote explicitly:

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

For local testing, `repo: local` is fine.

## 2. Optional: Clone a Private Repo First

If the private repo is not on disk yet, project-level Keyrail config cannot help because the project does not exist locally. Configure a user-level GitHub bootstrap profile, then clone through Keyrail:

```bash
keyrail profile set github personal-github --value-stdin
keyrail clone github acme/private-repo
cd private-repo
keyrail init --repo git@github.com:acme/private-repo.git
keyrail link github personal-github
```

Use `--value-stdin` so the PAT is not part of shell history. The Git remote remains a normal GitHub URL without the token.

## 3. Link Service Keys

Link the services this project uses:

```bash
keyrail link github acme-github-token
keyrail link vercel acme-vercel-token
keyrail link supabase acme-supabase-token
keyrail link openai acme-openai-dev
```

These names are references. They are safe to store in `.agent-context.yaml`.

If you want Keyrail to store a local development value:

```bash
keyrail link openai acme-openai-dev --value "$OPENAI_API_KEY"
```

Local values are written to `.keyrail/secrets.local.json`, which should stay out of git.

## 4. Check What the Agent Sees

```bash
keyrail current --json
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
- active context
- linked services
- ready vs reference-only keys
- the agent command pattern
- advanced manifest and audit views

This is the easiest path for non-technical users.

## 7. Common Patterns

Use environment variables instead of local file storage:

```bash
export VERCEL_TOKEN=...
keyrail link vercel acme-vercel-token
keyrail run -- vercel deploy
```

Remove a service link:

```bash
keyrail unlink vercel
```

List linked services:

```bash
keyrail current
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
keyrail link vercel acme-vercel-prod
```

High-risk contexts require confirmation unless you explicitly pass:

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

## 9. Advanced: Policy and Audit

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

## 10. Handoff to Another Agent

```bash
keyrail handoff --json
```

The handoff includes project identity, active context, linked services, and policy. It does not include raw secret values.
