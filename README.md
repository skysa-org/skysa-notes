# skysa-notes

**skysa-notes** is a local-first markdown notes PWA that syncs to a dedicated, app-owned folder on your own Google Drive, OneDrive, Dropbox, or WebDAV server. Every note is a plain `.md` file in an ordinary directory tree, so your notes stay readable, portable, and editable by any other tool, and folders are simply notebooks. The app reads and writes entirely from IndexedDB, so it works fully offline and syncs in the background when a connection returns; when you connect an OAuth provider your note content goes straight from the browser to that provider and never passes through the server, which stores only encrypted refresh tokens and connection metadata. It is built as a pnpm workspace — a Vite + React client, a Hono API on Cloudflare Workers backed by D1, and a framework-free core package holding the provider adapters, sync engine, and markdown pipeline — and it is designed to be self-hosted end to end on your own Cloudflare account. The project is in early development; [`docs/PLAN.md`](docs/PLAN.md) is the source of truth for the architecture, decisions, and phase order. Licensed under [AGPL-3.0](LICENSE).

## Development

Requires Node 22+ and pnpm 10 (`corepack enable`).

```bash
pnpm install
cp .dev.vars.example apps/api/.dev.vars   # fill in SECRETS_KEY at minimum
pnpm db:migrate                            # apply D1 migrations to the local database
pnpm dev                                   # Vite on :5173, wrangler dev on :8787
```

`pnpm dev` runs both servers; Vite proxies `/api` to the Worker so session cookies
stay first-party, matching production where one Worker serves the SPA and the API.

A WebDAV-only instance (`ENABLED_PROVIDERS="webdav"`) needs no provider app
registrations at all, which makes it the quickest way to run this locally.

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

Current status: **Phase 1 in progress.** The app runs locally: notebooks, notes, and both editors — rich text and raw markdown — over IndexedDB, with the mode remembered per note. Offline and installable is what's left. See [`docs/PLAN.md`](docs/PLAN.md).
