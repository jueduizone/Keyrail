# @keyrail/cli

Local-first project identity and credential routing for agent-assisted development.

```bash
npx @keyrail/cli attach github personal
npx @keyrail/cli status
npx @keyrail/cli run --dry-run -- vercel deploy
npx @keyrail/cli deploy vercel --prod --yes
npx @keyrail/cli ui
```

See the main repository README for details: https://github.com/jueduizone/Keyrail

Release readiness is checked from the repository root:

```bash
npm run smoke
npm run release:check
```

The smoke and release checks use temporary directories, dummy values, local dry-runs, and npm package inspection. They do not require real external services or secrets.
