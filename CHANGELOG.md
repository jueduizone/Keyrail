# Changelog

## 0.1.0

- Initial public release.
- Adds project identity manifests, context locks, policy-gated command execution, secret reference routing, audit logs, and a local management UI.
- Makes zero-init project routing the default: `status`, `attach`, `run`, policy, audit, and the UI work without writing Keyrail files into the project repository.
- Adds user-level service accounts and project bindings for agent-friendly private repo bootstrap and per-project credential routing.
- Adds safer policy entry with `keyrail policy allow -- <command>` and rejects empty `--value-stdin` secrets unless `--allow-empty` is explicit.
- Adds release-readiness automation with `npm run smoke` and `npm run release:check`, covering local CLI smoke paths, remediation output, npm package dry-runs, tarball contents, and unpacked-bin help without real network access or real secrets.
- Captures product feedback for multi-secret injection, env aliases, and Vercel env sync as next-priority workflows.
- Publishes workspace packages for CLI, core manifest utilities, policy evaluation, and pluggable secret backends.
