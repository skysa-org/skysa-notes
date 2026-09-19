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

Requires Node 22.13 or later and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm run setup      # asks what it needs and writes apps/api/.dev.vars
pnpm db:migrate     # apply D1 migrations to the local database
pnpm dev            # Vite on :5173, wrangler dev on :8787
```

`pnpm run setup` only asks for the providers you say you want; `.dev.vars.example`
documents every key if you would rather write the file by hand. The `run` is not
optional — `pnpm setup` is pnpm's own built-in command, as is `pnpm deploy`.

`pnpm dev` runs both servers; Vite proxies `/api` to the Worker so the app and the
API share an origin, matching production where one Worker serves both.

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
| `pnpm run setup` | Prompt for credentials and write `apps/api/.dev.vars` |
| `pnpm run deploy` | Build core, SPA and Worker, then `wrangler deploy` |

Current status: **Phase 7 — it syncs.** Notes and notebooks live in IndexedDB and work fully offline; connecting a Dropbox, OneDrive or Google Drive account syncs them to an app-owned folder, two-way, with conflicts resolved by keeping both copies. Both editors are in — rich text with a slash menu and formatting toolbar, and raw markdown — with full-text search, a command palette, a document outline, and find-and-replace across both. A device can hold several connected accounts at once and switch between them; each is its own silo, with its own notes, its own queue and its own credential.

What is not done: the one Phase 8 thing that cannot be checked from inside the repository — that a clean clone deploys end to end on a fresh Cloudflare account. There is no sign-in and there will not be one: identity and storage are coupled deliberately, so each connected account is its own silo and nothing on the server knows that two of them belong to one person (`docs/PLAN.md` §6). WebDAV is deferred indefinitely (§5.4).

Self-hosting it on your own Cloudflare account is [`docs/self-hosting.md`](docs/self-hosting.md). The architecture, the decisions and the phase order are in [`docs/PLAN.md`](docs/PLAN.md).
