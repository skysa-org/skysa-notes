# skysa-notes — instructions for Claude Code

Local-first markdown notes PWA syncing to an app-owned folder on Google Drive, OneDrive, or Dropbox (WebDAV is deferred indefinitely — `docs/PLAN.md` §5.4). Read `docs/PLAN.md` before any non-trivial task; it is the source of truth for architecture, decisions, and phase order. If a task requires deviating from it, say so and propose the edit to `docs/PLAN.md` in the same PR.

## Stack (do not substitute)
- pnpm workspace: `apps/web` (Vite + React + TS, TanStack Router, Dexie, vite-plugin-pwa), `apps/api` (Hono on Cloudflare Workers, D1 via Drizzle), `packages/core` (framework-free TS).
- Rich editor: Milkdown. Raw editor: CodeMirror 6.
- Identity: there is none, and that is the design, not a gap — each connected storage account is its own silo, reached by a credential the device holds (docs/PLAN.md §6, "Per-connection credentials"). Account-first sign-in is Phase 9. `docs/PLAN.md` §6 planned Arctic, its author deprecated it, and the choice between vendoring the two clients and a maintained alternative is still **open** — do not close it here. Storage OAuth, which is a different thing, is hand-rolled over Web Crypto and installs no dependency. Validation: zod. Tests: Vitest.

## Hard rules
- `packages/core` imports nothing from `apps/*` and has no framework, DOM, or Node-only dependencies. It must run in browser, Node, and Workers.
- `apps/api` code never touches `process.env` or Workers env except in `src/worker.ts`. Everything else receives config through `createApp(options)`.
- The markdown string is the only source of truth for a note. Editors are views. A note becomes dirty only on a user editing transaction, never on load, mode switch, or re-serialization.
- Never lose user data. On sync conflict, remote keeps the path; local is written as `<name> (conflict <timestamp>).md`.
- No note content is ever sent to or stored by `apps/api`. Only tokens and connection metadata. (WebDAV proxy streams; it does not persist.)
- **Three kinds of secret, three homes, and one of them is a knowing compromise.**
  1. *Provider access tokens* — memory + IndexedDB `syncState`, never localStorage. Short-lived and re-mintable.
  2. *Refresh tokens and WebDAV credentials* — only ever encrypted in D1, decrypted only in `POST /api/token`, never returned to the client.
  3. *The per-connection credential* (`sk1_…`, docs/PLAN.md §6) — generated in the browser, held in IndexedDB, and sent to the server **only as its SHA-256**. The server never holds the plaintext: not in D1, not in a log, not in a `Location`, a `Set-Cookie` or a body. There is a test that proves it by generating a known secret and grepping every response in the flow; do not delete it.

  This third one replaced an `httpOnly` session cookie, and that is a real loss, stated plainly so nobody later reads this list as saying IndexedDB is safe. It is not. An XSS that could previously mint tokens only while the page was open can now copy the credential out and use it until the device is revoked. What keeps the trade honest is **`script-src 'self'` with nothing inline or eval'd — a hard requirement, not a good default**. Nothing may be added to `script-src` in `apps/web/public/_headers`, and no inline script, `eval`, or `new Function` may be introduced into the shell. The `sk1_` prefix is the seam for a later proof-of-possession credential that would buy the property back.
- No operator-specific or deployment-specific code in this repo. Anything one deployment needs enters only through the `EntitlementProvider`, `RateLimiter` and `IdentityProvider` seams passed to `createApp`, and the env flags (`AUTH_MODE`, `ENABLED_PROVIDERS`). `AUTH_MODE=account-first` is Phase 9 and refuses to boot.
- Never commit secrets. `.dev.vars` is gitignored; `.dev.vars.example` lists every key.
- Every provider adapter must pass `packages/core/tests/providers/contract.test.ts`. Every markdown change must keep `tests/markdown/roundtrip.test.ts` green.

## Working style
- Work one phase (or one checklist item) at a time from `docs/PLAN.md`. Start in plan mode for anything touching more than one package.
- Prefer small PRs against `main`. Each PR: tests for new behavior, tick the checklist item in `docs/PLAN.md`, and — if it changes anything under `apps/` or `packages/` — a changeset (`pnpm run changeset`, or `--empty` when nothing observable moved). CI fails a PR that changes a package without one. The three workspace packages share one version and one `vX.Y.Z` tag; `.changeset/README.md` says why and how a release is cut.
- Commands: `pnpm dev` (web + wrangler dev), `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm build`.
- When unsure about a provider API detail (scopes, endpoints, conflict semantics), check the current vendor docs rather than assuming; note the URL in a code comment.
- Do not add dependencies without stating why in the PR description. Check license (MIT/Apache/ISC only).
