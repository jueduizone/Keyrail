# Changelog

## 0.1.0

- Initial public release.
- Adds project identity manifests, context locks, policy-gated command execution, secret reference routing, audit logs, and a local management UI.
- Makes zero-init project routing the default: `status`, `attach`, `run`, policy, audit, and the UI work without writing Keyrail files into the project repository.
- Adds user-level service accounts and project bindings for agent-friendly private repo bootstrap and per-project credential routing.
- Publishes workspace packages for CLI, core manifest utilities, policy evaluation, and pluggable secret backends.
