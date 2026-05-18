# Keyrail Agent Rules

- Use `npm run keyrail -- current` before making context-sensitive changes.
- Use `npm run keyrail -- doctor` when identity or credential routing is unclear.
- Run provider commands through `npm run keyrail -- run -- <command>` so policy and secret injection are enforced.
- Secret backends are pluggable; do not assume any specific third-party vault is required.
- Do not print raw secrets. `keyrail secrets list` shows references only.
- Production or high-risk contexts require explicit confirmation through `--yes` or `KEYRAIL_CONFIRM=1`.
