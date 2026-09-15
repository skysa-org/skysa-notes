# skysa-notes — instructions for Claude Code

Local-first markdown notes PWA syncing to an app-owned folder on Google Drive, OneDrive, Dropbox, or WebDAV. Read `docs/PLAN.md` before any non-trivial task; it is the source of truth for architecture, decisions, and phase order. If a task requires deviating from it, say so and propose the edit to `docs/PLAN.md` in the same PR.

## Stack (do not substitute)
- pnpm workspace: `apps/web` (Vite + React + TS, TanStack Router, Dexie, vite-plugin-pwa), `apps/api` (Hono on Cloudflare Workers, D1 via Drizzle), `packages/core` (framework-free TS).
- Rich editor: Milkdown. Raw editor: CodeMirror 6.
- Identity: hand-rolled OAuth over Web Crypto — Arctic was deprecated by its author before we needed it, so `docs/PLAN.md` §6 rejected it and nothing imports it. Validation: zod. Tests: Vitest.

## Hard rules
- `packages/core` imports nothing from `apps/*` and has no framework, DOM, or Node-only dependencies. It must run in browser, Node, and Workers.
- `apps/api` code never touches `process.env` or Workers env except in `src/worker.ts`. Everything else receives config through `createApp(options)`.
- The markdown string is the only source of truth for a note. Editors are views. A note becomes dirty only on a user editing transaction, never on load, mode switch, or re-serialization.
- Never lose user data. On sync conflict, remote keeps the path; local is written as `<name> (conflict <timestamp>).md`.
- No note content is ever sent to or stored by `apps/api`. Only tokens and connection metadata. (WebDAV proxy streams; it does not persist.)
- Provider access tokens live in memory + IndexedDB `syncState`, never localStorage. Refresh tokens and WebDAV credentials exist only encrypted in D1.
- No operator-specific or deployment-specific code in this repo. Anything one deployment needs enters only through the `EntitlementProvider` and `IdentityProvider` seams passed to `createApp`, and the env flags (`AUTH_MODE`, `ENABLED_PROVIDERS`).
- Never commit secrets. `.dev.vars` is gitignored; `.dev.vars.example` lists every key.
- Every provider adapter must pass `packages/core/tests/providers/contract.test.ts`. Every markdown change must keep `tests/markdown/roundtrip.test.ts` green.

## Working style
- Work one phase (or one checklist item) at a time from `docs/PLAN.md`. Start in plan mode for anything touching more than one package.
- Prefer small PRs against `main`. Each PR: tests for new behavior, and tick the checklist item in `docs/PLAN.md`. (Changesets are Phase 8 — there is no `.changeset/` directory or tooling yet, so do not write one.)
- Commands: `pnpm dev` (web + wrangler dev), `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm build`.
- When unsure about a provider API detail (scopes, endpoints, conflict semantics), check the current vendor docs rather than assuming; note the URL in a code comment.
- Do not add dependencies without stating why in the PR description. Check license (MIT/Apache/ISC only).
