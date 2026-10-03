# Contributing

Use Node.js 22.12+ and `npm ci`. Run `npm run dev` for the UI. Worker-source changes rebuild the worker, but an already active worker must finish serving its clients before the update activates; close all app tabs and reopen when changing worker code.

Before submitting a change:

```sh
npx playwright install chromium
npm run check
```

Keep the agent core in `src/core` (the turn loop in `runtime.ts`, with the turn record, restart recovery, migrations, storage, compaction, attachments, read-only tools, app calls and prompts in their own modules), model adapters in `src/models`, sign-ins and their settings in `src/connections`, browser persistence in `src/browser`, plugin/MCP plumbing in `src/plugins`, and UI in `src/ui`. See the [architecture review](docs/architecture-review.md) for the module map and the open improvement plan. Change behavior with a focused regression test. Do not add live credentials or require a paid provider in tests. Tests use a mock model, fake IndexedDB for unit tests, and actual browser storage/workers in Playwright. `tests/node` runs the core with `MemoryStore` and no browser globals, which is how an eval drives it.

Use design tokens in `src/ui/tokens.css`; these track the Kinetik Charms visual language. Only contribute source and assets that you have permission to distribute under this project's license. Include screenshots for visible UI changes and identify which browsers you tested.

Plugin SDK changes must update `docs/plugins.md` and the example plugin. Distinguish working behavior from future design in documentation. The current limitation on official ChatGPT authentication must not be removed without verified evidence and a corresponding integration test.

Open an issue for proposals, or a pull request with the problem, change, and verification. Keep commits scoped. Report security issues according to `SECURITY.md`.
