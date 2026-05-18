# Keyrail Tutorial

This tutorial walks through a practical local setup for a project with `local`, `staging`, and `production` contexts.

## 1. Initialize a Project

From a repository root:

```bash
keyrail init --id acme-web --name "Acme Web" --repo local
```

Use `--repo local` for early local testing. In a real repository, use the Git remote:

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

This creates:

```text
.agent-context.yaml
.ctx/lock.yaml
```

## 2. Check Identity

```bash
keyrail identify
keyrail current
keyrail doctor
```

`identify` reports signals such as Git remote and package name. `current` shows the active project and context. `doctor` checks whether the manifest, identity, and secret references are usable.

## 3. Add Contexts

```bash
keyrail context add staging --risk medium
keyrail context add production --risk high --confirm
keyrail context list
```

Switch contexts:

```bash
keyrail context use staging
```

The active context is stored in `.ctx/lock.yaml`, so a resumed terminal or agent session does not have to guess.

## 4. Add Secret References

Secret references are names, not raw values:

```bash
keyrail secrets set openai acme-openai-dev
keyrail secrets set github acme-github-limited
keyrail secrets list
```

If you pass `--value`, Keyrail stores the value in the local development backend:

```bash
keyrail secrets set openai acme-openai-dev --value "$OPENAI_API_KEY"
```

The local backend writes to:

```text
.keyrail/secrets.local.json
```

That file is ignored by git.

## 5. Add Command Policy

Allow safe commands:

```bash
keyrail policy allow gh issue list
keyrail policy allow vercel deploy
```

Require confirmation for risky commands:

```bash
keyrail policy require-confirm vercel deploy --prod
```

Deny dangerous commands:

```bash
keyrail policy deny gh repo delete
```

View policy:

```bash
keyrail policy show
```

## 6. Run Commands Safely

Run commands through Keyrail:

```bash
keyrail run -- gh issue list
```

Keyrail will:

1. verify the project identity
2. resolve the active context
3. evaluate policy
4. inject resolved secrets into the child process
5. redact command output
6. write an audit event

## 7. Protect Production

Production contexts should be high risk:

```yaml
contexts:
  production:
    risk: high
    require_confirmation: true
    secrets:
      vercel: acme-vercel-prod
```

In non-interactive automation, use:

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

For manual use, Keyrail asks you to type the project/context name before high-risk execution.

## 8. Use the Local UI

Start the UI:

```bash
keyrail ui
```

Open the printed URL. The UI can switch contexts, edit the manifest, inspect secret references, and review audit events.

## 9. Handoff to an Agent

Generate an agent-readable summary:

```bash
keyrail handoff
keyrail handoff --json
```

The handoff includes project identity, active context, policy, and secret references. It never includes raw secret values.

## 10. Audit

View recent execution decisions:

```bash
keyrail audit list
keyrail audit list --json
```

Audit entries include command, context, decision, injected references, and missing references. They do not include raw secret values.
