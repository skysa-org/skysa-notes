# skysa-notes

**skysa-notes** is a local-first markdown notes PWA that syncs to a dedicated, app-owned folder on your own Google Drive, OneDrive, or Dropbox. Every note is a plain `.md` file in an ordinary directory tree, so your notes stay readable, portable, and editable by any other tool, and folders are simply notebooks. The app reads and writes entirely from IndexedDB, so it works fully offline and syncs in the background when a connection returns; when you connect an OAuth provider your note content goes straight from the browser to that provider and never passes through the server, which stores only encrypted refresh tokens and connection metadata. It is built as a pnpm workspace — a Vite + React client, a Hono API on Cloudflare Workers backed by D1, and a framework-free core package holding the provider adapters, sync engine, and markdown pipeline — and it is designed to be self-hosted end to end on your own Cloudflare account. The project is in early development; [`docs/PLAN.md`](docs/PLAN.md) is the source of truth for the architecture, decisions, and phase order. Licensed under [AGPL-3.0](LICENSE).

## Contributing

Bug reports and small focused pull requests are both welcome; see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get it running and what a change
is expected to carry, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for how
people are expected to treat each other. Contributors sign a
[CLA](CLA-individual.md) once — a licence grant, not an assignment: you keep
ownership of your work and every right to use it elsewhere, and in exchange the
project is bound to keep every contribution available under AGPL-3.0.

Security problems go through [private reporting](SECURITY.md), never a public
issue. The project name and logo are not covered by the code licence
([`TRADEMARK.md`](TRADEMARK.md)); forks rebrand. The copyright notice is in
[`NOTICE`](NOTICE) — `LICENSE` is a verbatim copy of the AGPL and stays one.

The legal texts are **drafts that have not been reviewed by counsel** and say so
at the top.

## Development

Requires Node 22+ and pnpm 10 (`corepack enable`).

```bash
pnpm install
cp .dev.vars.example apps/api/.dev.vars   # fill in SECRETS_KEY and credentials for each provider in ENABLED_PROVIDERS
pnpm db:migrate                            # apply D1 migrations to the local database
pnpm dev                                   # Vite on :5173, wrangler dev on :8787
```

`pnpm dev` runs both servers; Vite proxies `/api` to the Worker so session cookies
stay first-party, matching production where one Worker serves the SPA and the API.

Every provider that syncs needs its own app registration (Dropbox, Microsoft
Entra or Google Cloud) and credentials in `apps/api/.dev.vars`; see
`.dev.vars.example`. WebDAV support is deferred indefinitely (`docs/PLAN.md`
§5.4).

| Command | What it does |
|---|---|
| `pnpm dev` | Web + API dev servers |
| `pnpm build` | Build core, SPA, then a Worker dry-run bundle |
| `pnpm test` | Vitest across all packages |
| `pnpm lint` / `pnpm lint:fix` | ESLint across all packages, with or without auto-fix |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm verify` | format:check + lint + typecheck + test — run before every commit |
| `pnpm db:generate` | Generate a Drizzle migration from the schema |
| `pnpm db:migrate` / `pnpm db:migrate:remote` | Apply migrations locally / to Cloudflare |

Current status: **Phase 2 in progress — the engine and the backend are done, the client wiring is not.** Phase 1 shipped the app that runs locally and offline: notebooks, notes, and both editors — rich text with a slash menu and a formatting toolbar, and raw markdown — over IndexedDB, with the mode remembered per note, installable as a PWA.

Since then: a provider contract suite and an in-memory fake, a `DropboxProvider` against it, the backend that holds only encrypted refresh tokens and mints short-lived access tokens (OAuth start/callback, sessions, `/api/token`), and the sync engine — pull, push, cursor persistence and the op queue — behind a `SyncStore` port.

What is left before anything actually syncs is the client half: the typed API client, the scheduler, the connect and status UI, and the Dexie implementation of `SyncStore`. Until that lands the app still stores everything locally and talks to nobody. The Dropbox app is also not registered yet, so the OAuth round trip is proven against stubs rather than against Dropbox. See [`docs/PLAN.md`](docs/PLAN.md).
