# skysa-notes — Implementation Plan

Local-first markdown note-taking PWA that syncs to a dedicated, app-owned folder on the user's cloud storage (Google Drive, OneDrive, Dropbox) or to any WebDAV server. Notes are plain `.md` files in a normal directory tree, so the user can open, edit, and back them up with any other tool.

This repo is the complete, self-hostable product: one Cloudflare Worker serving the SPA and a small API, plus the operator's own provider app registrations. This document is the source of truth for architecture and sequencing. Update it when decisions change.

---

## 1. Core decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Storage model | App creates and owns a dedicated root folder on each provider; never touches anything outside it | Keeps every provider on user-consent-only scopes; avoids Google restricted-scope (CASA) review |
| File format | One markdown file per note, folders = notebooks, optional YAML frontmatter | Human-readable, portable, diffable, editable by other tools |
| Identity | Notes identified locally by UUID; remote identity is provider file id (Drive/Graph/Dropbox) or path (WebDAV) | Ids survive renames on id-based providers; WebDAV has nothing else |
| Client | Vite + React + TypeScript SPA, `vite-plugin-pwa` (Workbox) for the service worker, TanStack Router, Dexie (IndexedDB) for local store | Local-first app gets nothing from SSR; vite-plugin-pwa is the best-maintained PWA tooling in the React ecosystem |
| Backend | Hono + TypeScript on Cloudflare Workers, D1 via Drizzle | Tiny, streams bodies natively (WebDAV proxy), Workers-native |
| Repo | pnpm workspace: `apps/web`, `apps/api`, `packages/core` (providers, sync, markdown — framework-agnostic) | Keeps the hard parts testable without any UI or server framework |
| Hosting | Cloudflare Workers for the API, Workers static assets for the SPA (same origin), D1 for the database | One deploy, same-origin cookies, SQLite dialect in dev and prod |
| App folder name | `skysa-notes`, defined once as `APP_FOLDER_NAME` in `packages/core/src/config.ts`; changeable before launch | Provider registrations must match — see §5 |
| Accounts | One storage connection per user until Phase 7; schema supports many | Keep v1 UX simple |
| Sign-in | Two modes selected by `AUTH_MODE`. `storage-first` (default): the user *is* their first connected storage account. `account-first`: Sign in with Google or Microsoft (`openid email profile`), fully separate from the storage connection; Dropbox users sign in with one of those and then connect Dropbox. No magic link. Identity layer built on an `IdentityProvider` adapter (via Arctic) so Facebook/Apple can be added later without structural change | `storage-first` is the shortest path for a personal instance; `account-first` keeps identity unbound from storage so users can swap providers and link several sign-ins. See §6 |
| Distribution | One public repo that is the complete, self-hostable product. No operator-specific configuration or credentials in the tree | A clean clone must deploy end to end on a fresh Cloudflare account |
| License | AGPL-3.0 with a CLA for contributors; trademark on the name/logo held separately | Real open source; network copyleft keeps modified deployments open; CLA preserves relicensing options. See §13 |
| Provider enablement | `ENABLED_PROVIDERS` env selects which of `gdrive,onedrive,dropbox,webdav` an instance offers | Operators who disable WebDAV remove the only path where content transits the server and the only SSRF surface |
| Note content | The server never stores note content, only tokens and connection metadata. For OAuth providers content never transits the server at all; WebDAV content streams through the proxy and is never persisted | Core privacy promise |
| Token flow | Backend does Authorization Code + PKCE with every OAuth provider, stores refresh tokens encrypted, mints short-lived provider access tokens for the client; **client talks directly to provider APIs for file content** | Uniform auth across providers, no client secrets in bundle, no file bytes through our server (except WebDAV) |
| Offline | Full read/write offline against IndexedDB; sync queue drains when online | It's a PWA; sync is a background concern |
| Conflicts | Never lose data. On conflict, keep the remote version at the original path and write local as `<name> (conflict <YYYY-MM-DDTHH-mm>).md` | Simple, predictable, recoverable |
| Editor | Rich-text (WYSIWYG) by default, raw markdown mode as a toggle; **the markdown string is the only source of truth** — the rich editor is a view over it | Notes are files; the editor must never own state the file can't represent |

Non-goals for v1: real-time collaboration, sharing, full-drive access, mobile-native wrappers, attachments/images, syntax beyond CommonMark + GFM (tables, task lists, strikethrough).

---

## 2. Architecture overview

```
┌──────────────────────────── Browser (PWA) ────────────────────────────┐
│  UI (React)                                                            │
│   └─ Notes store (Dexie/IndexedDB) ── Sync engine ── Provider adapter  │
│                                              │                         │
│  Service worker (Workbox via vite-plugin-pwa): app-shell cache, bg sync │
└──────────┬───────────────────────────────────┼─────────────────────────┘
           │ session cookie                    │ provider access token (bearer)
           ▼                                   ▼
┌── Backend (Hono on CF Workers) ──────┐   ┌── Provider APIs ──────────────┐
│  /api/auth/*      OAuth start/callback│   │  Google Drive v3 (CORS ok)    │
│  /api/connections CRUD               │   │  Microsoft Graph (CORS ok)    │
│  /api/token       mint access token  │   │  Dropbox v2 (CORS ok)         │
│  /api/webdav/*    proxy (CORS shim)  │──▶│  WebDAV server (via proxy)    │
│  D1: users, sessions, connections    │   └───────────────────────────────┘
└──────────────────────────────────────┘
```

Key property: the backend is only required for (a) connecting/refreshing an account and (b) WebDAV. Once a client holds a valid access token it syncs peer-to-provider. If the backend is down, the app still works offline and can sync to OAuth providers until the access token expires.

---

## 3. Note format and directory layout

Remote root folder (app-owned), `skysa-notes/` (`APP_FOLDER_NAME`):

```
skysa-notes/
├── .notesapp.json            # marker file, see below
├── Inbox/
│   └── quick-thought.md
├── Work/
│   ├── 2026-q3-planning.md
│   └── Meetings/
│       └── 2026-09-14-standup.md
└── Personal/
    └── reading-list.md
```

Marker file `.notesapp.json`, written by `ensureRoot()` on first connect and never modified by the sync engine afterward (a new device does not overwrite it):

```json
{
  "schemaVersion": 1,
  "app": "skysa-notes",
  "createdAt": "2026-09-14T13:02:11Z",
  "createdBy": {
    "appVersion": "0.1.0",
    "provider": "dropbox",
    "clientId": "018f3c4e-...",       // random UUID per browser install, stored in IndexedDB syncState
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

`createdBy` exists only for debugging (which install created this folder, with what version). It contains no account identifiers. `schemaVersion` gates future layout migrations; if a client sees a higher version than it understands, it opens read-only with a banner.

Note file:

```markdown
---
id: 018f3c4e-...          # UUID, written by the app; used to re-link after moves on path-based providers
title: 2026 Q3 Planning
created: 2026-09-14T13:02:11Z
updated: 2026-09-14T15:40:03Z
tags: [planning, work]
---

# 2026 Q3 Planning

Body is plain CommonMark. ...
```

Rules:
- Frontmatter is optional on read (files created by other tools are valid notes). The app adds it on first write.
- Filename is a slug of the title; the app renames the file when the title changes. `id` in frontmatter is the stable identity.
- Folder names are user-facing notebook names. Reserved prefix: anything starting with `.` is ignored by the UI.
- Line endings normalized to `\n` on write. UTF-8 only.

---
## 4. Provider adapter interface

Every provider implements this. The sync engine only talks to this interface.

```ts
export interface RemoteEntry {
  remoteId: string;        // provider file id; the path itself on WebDAV
  path: string;            // relative to app root, POSIX separators, normalized
  kind: 'file' | 'folder';
  version: string;         // etag / rev / cTag / headRevisionId — opaque, compare for equality only
  modifiedAt: string;      // ISO
  size?: number;           // UTF-8 bytes; absent for folders
}

/** What read/move/delete need, which is all the local store keeps. */
export type EntryRef = Pick<RemoteEntry, 'remoteId' | 'path'>;

/** A deletion carries only a path: Dropbox's DeletedMetadata has no id or rev. */
export interface DeletedEntry { path: string; deleted: true; remoteId?: string }

export type ChangeEntry = (RemoteEntry & { deleted?: false }) | DeletedEntry;

export interface ChangeSet {
  entries: readonly ChangeEntry[];
  cursor: string;          // opaque; persist per connection
  more: boolean;
}

export interface WriteOptions {
  /** Omitted means "create": a file already there is a ConflictError. */
  expectedVersion?: string;
}

export interface StorageProvider {
  readonly kind: ProviderKind;
  readonly ensureRoot: () => Promise<{ rootId: string }>;
  readonly list: (folderPath: string) => Promise<RemoteEntry[]>;
  readonly read: (entry: EntryRef) => Promise<{ content: string; version: string }>;
  readonly write: (path: string, content: string, opts: WriteOptions) => Promise<RemoteEntry>;
  readonly createFolder: (path: string) => Promise<RemoteEntry>;
  readonly move: (entry: EntryRef, newPath: string) => Promise<RemoteEntry>;
  readonly delete: (entry: EntryRef) => Promise<void>;
  readonly changes: (cursor?: string) => Promise<ChangeSet>;
}

export class ConflictError extends Error { constructor(readonly remote: RemoteEntry) { … } }
export class AuthError extends Error {}          // engine asks the backend for a fresh token
export class NotFoundError extends Error {}      // entry gone, or expectedVersion for an absent path
export class CursorResetError extends Error {}   // cursor unusable; discard it and full-scan
```

Three shapes differ from the sketch this section used to carry. Members are property signatures rather than methods, which is both the house style (`EntitlementProvider`) and what `functional/prefer-property-signatures` requires. `kind` reuses `ProviderKind` from `config.ts` so `PROVIDER_KINDS` stays single-sourced with the marker schema. And `read`/`move`/`delete` take an `EntryRef`, not a whole `RemoteEntry`: a note record persists only `remoteId`, `remoteVersion` and `path`, so passing the full entry would have every caller inventing a `kind` and a `modifiedAt` — and let an adapter come to depend on the invented value.

`NotFoundError` and `CursorResetError` are additions. A cursor can go stale on every provider (Dropbox answers `reset`, Graph `410 resyncRequired`, WebDAV invalidates its sync-token) and without a type for it the engine cannot tell a dead cursor from a transient failure, so it retries forever. `NotFoundError` is what lets `ConflictError.remote` stay non-optional.

Each error carries a `code` alongside its class, and ships with an `isXError` guard. `instanceof` is the ergonomic check and is correct today, since `@skysa/core` resolves to one module per bundle; the code keeps the guards honest if core is ever published and a consumer ends up holding two copies of it either side of a sync boundary.

Semantics the signatures do not carry:

- `write` is create-or-update, never a blind overwrite. No `expectedVersion` means "I expect nothing here" — literally WebDAV's `If-None-Match: *` — so a file already at that path is a `ConflictError`. That is what makes §7's "remote deleted, local dirty → re-create on push" safe: if the file came back in the meantime the write conflicts instead of clobbering it. An `expectedVersion` for a path with no file is a `NotFoundError`.
- `createFolder` and `delete` are idempotent, so a queued op is always safe to replay.
- `move` may or may not change `version` — Dropbox's `rev` survives it, OneDrive's `eTag` does not — so the caller stores the returned entry rather than assuming either way. `remoteId` survives a move on every id-based provider; on WebDAV it *is* the path and so cannot, which is why renames there are re-linked through frontmatter `id`.
- A deletion is identified by its **path**, not its id. Dropbox's `DeletedMetadata` carries a name and a path and nothing else — no id, no rev, no timestamp — so `ChangeEntry` is a union rather than an entry with a flag. Anything richer would have adapters fabricating fields and the engine trusting them.
- `list` is one level. `changes` covers the whole tree at every depth. Neither filters hidden paths: `.notesapp.json` has to reach the engine, and the UI filters with `isHidden`.
- `rootId` is opaque, non-empty and stable. A provider whose root has no id of its own — a Dropbox app folder, where the root simply *is* `/` — returns a synthetic constant.
- Content is UTF-8 text. Binary attachments are out of scope (§14).
- No `AbortSignal`: operations are short and the engine discards results it no longer wants. Revisit in Phase 6 if a hung request ever blocks a queue.
- Transport failures (429 with `Retry-After`, 5xx) surface as plain errors and are handled by the engine's per-op backoff. A typed `RateLimitError` is purely additive and can land with whichever adapter first needs the server's hint.

Adapter contract tests: the scenario suite is `describeProviderContract(name, harnessFactory, { stableIds })` in `packages/core/tests/providers/contract.ts` — a helper rather than a test file, so Vitest's `tests/**/*.test.ts` glob does not collect it on its own. `tests/providers/contract.test.ts` is the registry every adapter is added to: the in-memory fake in CI, and live accounts via `PROVIDER_LIVE_TESTS=1` locally. `stableIds: false` exempts path-based providers from the move-preserves-id scenarios.

Scenarios: idempotent `ensureRoot` including write-the-marker-only-if-absent, path normalization at the adapter edge, byte fidelity on read-back, the four `write` cases above, one-level `list` including hidden entries, idempotent `createFolder`, move (file, into a folder, whole folder rebasing its descendants, onto an occupied path), idempotent recursive `delete`, and a `changes` feed that scans current state on a cold start rather than replaying history, reflects each step, survives being persisted, and is drained through its `more` loop.

The in-memory fake in `src/providers/fake.ts` is deliberately the strictest provider in the repo: where this section leaves a case open it takes the least forgiving reading, because a lenient fake lets the engine grow assumptions that only fail against a real account. It never creates a missing parent, re-versions even a byte-identical write, and never reuses an id. Its `pageSize`, `folderChanges` and `setFault` options are what let the engine's drain loop, folder rebasing, and auth-retry paths be tested at all.

---

## 5. Provider specifics

### 5.1 Google Drive
- Scope: `https://www.googleapis.com/auth/drive.file` plus `openid email` for identity. Non-restricted; standard OAuth verification only.
- Root: create folder `APP_FOLDER_NAME` (mimeType `application/vnd.google-apps.folder`) at drive root, tag with `appProperties: { notesapp: "root" }`. Search by `appProperties` (not name) on reconnect before creating, so a user rename doesn't cause a duplicate.
- Files: `mimeType: text/markdown`. Upload via `uploadType=multipart` for create, `PATCH /upload/drive/v3/files/{id}?uploadType=media` for content updates.
- Version: `headRevisionId` (also read `md5Checksum`). Drive does not reliably honor `If-Match` on content updates, so `write()` does read-metadata → compare → write, and the sync engine treats the small race window as a conflict on the next `changes()` pass.
- Changes: `changes.getStartPageToken` on connect, then `changes.list` with `pageToken`, `spaces=drive`, `fields=changes(fileId,removed,file(id,name,mimeType,parents,headRevisionId,modifiedTime,trashed))`. Only app-visible files appear under `drive.file`, which is exactly what we want.
- Path reconstruction: Drive is id/parent based. Maintain a local `remoteId → parentId, name` map and derive paths; treat a parent change as a move.
- Tokens: backend exchanges the auth code with `access_type=offline&prompt=consent` to get a refresh token. Access tokens last 1h; client requests a new one from `/api/token` on `AuthError` or proactively at 55m.

### 5.2 OneDrive (Microsoft Graph)
- Scopes: `Files.ReadWrite.AppFolder offline_access openid email`. User consent only.
- Root: `GET /me/drive/special/approot` — Microsoft creates `/Apps/<AppName>` automatically, where `<AppName>` is the Entra app registration display name. Register it as `skysa-notes` to match `APP_FOLDER_NAME`; no ensureRoot creation logic beyond writing `.notesapp.json`.
- Files: `PUT /me/drive/items/{parentId}:/{name}:/content` (simple upload, fine for markdown; add resumable session only if a file ever exceeds 4 MB). `If-Match: <eTag>` is honored → real server-side conflict detection.
- Version: `eTag` (or `cTag` for content-only). Use `eTag`.
- Changes: `GET /me/drive/special/approot/delta`, follow `@odata.nextLink`, persist `@odata.deltaLink` as cursor. Deleted items carry a `deleted` facet.
- Paths: items include `parentReference.path`; strip the approot prefix.
- Tokens: refresh tokens issued to the backend; access tokens ~1h.

### 5.3 Dropbox
- App type: **App folder** access. Scopes: `files.metadata.read files.metadata.write files.content.read files.content.write account_info.read`.
- Root: with App folder access, the API root *is* `/Apps/<AppName>`, where `<AppName>` is the app name set in the Dropbox App Console (immutable after creation — create it as `skysa-notes`). All paths are relative to it. ensureRoot just writes `.notesapp.json` at `/`.
- Files: `POST content.dropboxapi.com/2/files/upload` with `mode: { ".tag": "update", update: rev }` for conflict-safe overwrite (Dropbox returns a conflict error rather than auto-renaming when `autorename: false`). `mode: add` for create. **`strict_conflict: true` is required**: without it an `update` whose rev no longer matches still succeeds when the file has since been deleted, which is exactly the case the expected version exists to catch.
- `Dropbox-API-Arg` is an HTTP header, so it must be ASCII: every character above printable ASCII has to be `\uXXXX`-escaped or a notebook named in a non-Latin script fails at the transport with an unhelpful 400.
- Errors: only a **409** carries an endpoint-specific `error_summary`; any other status may carry plaintext or an intermediary's HTML, so a tag is only ever read out of a 409, and by whole `/`-separated segment rather than substring. Otherwise a 503 whose body happens to say `conflict` would have the conflict rule copy the user's note aside over an outage. Match by segment, not equality — Dropbox says the tail carries detail that can change. A conflict does not include the current entry, so the adapter fetches it with `files/get_metadata` before raising `ConflictError`; that extra round trip happens only on the conflict path.
- `strict_conflict` also means Dropbox answers `conflict` for an `update` whose file has been **deleted**, where §4 calls for `NotFoundError`. The adapter tells them apart by looking the path up after a conflict: no entry plus an expected version is the deleted case. The engine's re-create-on-push path depends on it.
- `path_display` is nullable in Dropbox's spec. Defaulting a missing one to the empty string would produce an entry pointing at the app-folder **root**, which a later `delete` would act on, so the adapter refuses such metadata loudly instead.
- A cursor Dropbox cannot parse comes back as a plain **400**, not as `reset`. Both mean discard and re-scan; only one is typed, so the adapter maps a 400 from `list_folder/continue` to `CursorResetError` too. Without it a truncated cursor is retried forever.
- Folders have no `rev` and no `server_modified`. The adapter reports both as empty rather than inventing them, and nothing compares either for a folder.
- Version: `rev`.
- Changes: `files/list_folder` with `recursive: true` on first sync (returns cursor), then `files/list_folder/continue`. Optional later: `files/list_folder/longpoll` for near-instant sync while the tab is open.
- Paths: use `path_display`; Dropbox also gives an `id` (`id:...`) — store both, prefer id for identity.
- Tokens: `token_access_type=offline` → refresh token. Access tokens ~4h.
- Note: production apps need Dropbox "production" approval once past the dev user cap; App-folder apps have a light review.

### 5.4 WebDAV
- Auth: URL + username + password (app password recommended). Stored encrypted on the backend; the client never sees them.
- Transport: **all WebDAV traffic goes through `/api/webdav/*`** because most servers don't emit CORS headers. The proxy forwards method/headers/body verbatim, injects Basic auth, restricts to the configured base URL, and streams bodies. Supported methods: `PROPFIND`, `GET`, `PUT`, `MKCOL`, `MOVE`, `DELETE`, `REPORT`.
- Root: the user supplies a base URL that *is* the app folder (e.g. `https://cloud.example.com/remote.php/dav/files/david/Notes/`). ensureRoot does `PROPFIND depth 0`, `MKCOL` if 404, then writes `.notesapp.json`.
- Files: `PUT` with `If-Match: <etag>` for updates, `If-None-Match: *` for creates. Version = `ETag` (strip weak prefix `W/` and normalize quotes).
- Changes: no universal delta. Strategy in order of preference:
  1. RFC 6578 `sync-collection` REPORT if the server advertises it (Nextcloud/ownCloud/SabreDAV do) — cursor is the `sync-token`.
  2. Fallback: full recursive `PROPFIND depth infinity` (or depth 1 walk if infinity is refused) diffed against the last snapshot. Cap frequency (e.g. on app open + every 5 min while active).
- Identity: path-based. After a `changes()` pass, re-link renamed files by reading frontmatter `id` of any "new" file whose size/etag suggests it might be a moved note. Accept that renames done outside the app look like delete+create in the worst case.

---

## 6. Backend

Hono app in `apps/api`, deployed to Cloudflare Workers with `wrangler`. Keep it boring.

- Runtime: Workers only. Use Web Crypto (`crypto.subtle`) for AES-GCM, `fetch` for provider calls, no Node built-ins. `wrangler dev` locally (Miniflare) with a local D1.
- Database: D1 via `drizzle-orm/d1`, migrations with `drizzle-kit generate` + `wrangler d1 migrations apply`. Same SQLite dialect locally and in prod.
- Secrets: provider client ids/secrets and `SECRETS_KEY` via `wrangler secret put`; never in `wrangler.toml`.
- Static SPA served from the same Worker via `[assets]` in `wrangler.toml` (SPA fallback to `index.html`), so `/api/*` and the app share an origin and cookies are first-party.
- **Composition root:** `apps/api` exports `createApp({ entitlements, identityProviders, config })` as a library; its own `src/worker.ts` calls it with the defaults. An operator who needs different behavior writes their own Worker entry that imports `createApp` and passes their own implementations, instead of forking. Nothing in `apps/api` reads env directly except `worker.ts`.
- Sessions with `hono/cookie`; request validation with `zod` + `@hono/zod-validator`.
- **Entitlement seam:** every route that mints a token or proxies WebDAV calls `entitlements.check(userId)` from an `EntitlementProvider` interface in `core`. The repo ships `AlwaysAllowed`. Operators of a shared instance can substitute their own (an email allowlist, for example) through `createApp`; no such policy logic lives in the repo.
- **Provider enablement** (`ENABLED_PROVIDERS` env, default `gdrive,onedrive,dropbox,webdav`): the WebDAV routes and proxy are not mounted when `webdav` is absent, and the client hides the option.
- **Identity modes** (`AUTH_MODE` env): `storage-first` (default: user = first connected storage account, as below) or `account-first` (Sign in with Google or Microsoft creates the user; storage is connected in a separate flow afterward). Both write to the same `users` table. `account-first` suits instances shared by several people, and users who want to change storage provider without losing their account.
- **Two OAuth flows per provider, never combined.** `/auth/login/:provider` requests identity scopes only (`openid email profile`); `/auth/connect/:provider` requests storage scopes only. They share one Google client id / one Entra registration but use distinct redirect URIs and distinct callback routes. On the storage request pass `include_granted_scopes=true` (Google) so the second consent screen shows only the new scope; frame it in the UI as "Connect your storage", not as a second login.
- **Identity providers via Arctic** (`arctic` npm, Workers-compatible): Google and Microsoft Entra at launch. **Open (2026-09-14): `arctic` was deprecated by its author in July 2026 ("no longer supported"); they suggest copying the per-provider client code, which is ~50 lines each.** Nothing depends on it before Phase 9, so the dependency is not installed yet. Decide then between vendoring the two clients into `apps/api/src/identity/` (no runtime dep, and the storage OAuth in `oauth/` is hand-rolled anyway) or a maintained alternative. `IdentityProvider` interface in `apps/api/src/identity/` returns `{ providerId, subject, email, emailVerified, name }`. Adding Facebook or Apple is a new adapter + registration; Facebook would additionally need an email-confirmation fallback (email is not guaranteed from Meta) and Meta App Review with a data-deletion URL, so it is deferred.
- **Account linking (`account-first` mode):** `identities` table (`user_id, provider, subject, email, email_verified`). Two paths:
  1. *Automatic merge-by-verified-email.* On any sign-in, look up `identities` by `(provider, subject)` first. If absent, and the provider asserts `email_verified: true`, and a user with that email exists, attach the new identity to that user. Unverified emails and relay addresses never auto-link; they create a new user.
  2. *Explicit in-session link.* From Settings, a signed-in user starts `/auth/login/:provider/start?link=1`; the callback attaches the resulting identity to the current user regardless of email. This is the path for Apple Hide-My-Email, differing emails across providers, and account recovery. If the identity is already attached to a different user, refuse with a clear message rather than merging users.
  Settings shows linked providers and encourages linking a second one. No magic link at launch; the `identities` design leaves room for an `email` provider type later (see §14).
- WebDAV proxy: stream request/response bodies straight through (`c.req.raw.body` → upstream `fetch` → return `Response`); enforce a 30 s upstream timeout with `AbortSignal.timeout` and a 20 MB cap regardless of Cloudflare plan limits.

### Storage OAuth, as built (Phase 2)

Dropbox is the first storage flow and the shape the others follow.

- **Hand-rolled, not Arctic.** The storage flows are Authorization Code + PKCE and about forty lines each; `arctic` is deprecated (see above) and is not installed. Identity sign-in in Phase 9 is a separate decision.
- **The PKCE verifier and `state` ride in a short-lived signed cookie** (`skysa_flow`, 10 minutes, `httpOnly`, `sameSite=lax`), not a table. §9 wants `state` bound to the browser that started the flow, which is what a cookie *is*; a table would need a sweep job and a KV binding neither of which exists. The payload is signed because an attacker who could rewrite it could otherwise substitute their own `state` and complete a flow the user never began.
- **`sameSite=lax`, not `strict`**, on both cookies: the callback is a top-level navigation arriving from the provider, and `strict` would drop the cookie exactly when it is needed. `secure` is derived from `APP_ORIGIN` so plain-HTTP local development still works.
- **The HMAC key is derived from `SECRETS_KEY` through HKDF**, not imported from the same bytes that do AES-GCM. One key, two algorithms, is how key-separation bugs start.
- **`token_access_type=offline`**, and a grant that comes back without a refresh token is a 502 rather than a stored connection that would stop working in four hours with no way to recover.
- **A unique index on `connections(user_id, provider)`** (migration `0001_connection_per_provider`) turns reconnecting into an `ON CONFLICT DO UPDATE` instead of a read-then-write race between two tabs. It also makes §12.3 a constraint rather than a UI convention. Reconnecting clears `root_id`: a new grant can point at a different account.
- **`SECRETS_KEY` must decode to exactly 32 bytes**, checked at boot. It was `.min(1)`, which meant an operator mistake surfaced the first time somebody tried to connect an account. (The existing test fixture turned out to decode to 30 bytes.)
- **`returnTo` is confined to this app.** Anything not starting with a single `/` becomes `/`.
- **`/api/token` decrypts the refresh token and returns only the access token.** It is the first `entitlements.check(userId)` call site, and it re-seals a rotated refresh token so the connection survives a rotation Dropbox is allowed to do.
- **Disconnecting revokes best-effort and deletes regardless.** A user who asked to disconnect must not be left connected because the provider was down.

**Test harness.** `@cloudflare/vitest-pool-workers` — which would give the tests Miniflare's real D1 — still peers on `vitest ^4.1.0` against this workspace's 5, so it cannot be installed. The fallback is a ~120-line D1 shim over Node 22's built-in `node:sqlite` (`apps/api/tests/d1.ts`), which keeps the real `drizzle-orm/d1` driver, the real schema and the real migration files; only the process hosting SQLite differs. No new dependency. Swap it for the pool once that supports Vitest 5.

### What review changed (Phase 2, PR 3)

Fourteen findings, each reproduced before it was fixed and each now pinned by a test. Worth recording because most of them are the *kind* of bug the next three providers can repeat:

- **A malformed cookie signature threw where a wrong one returns false.** `crypto.subtle.verify` answers `false`; `atob` throws. The caller reads a cookie an attacker may have written, so the two must look the same — and because the flow cookie was only cleared after being read, one bad cookie wedged every later callback with a 500. The cookie is now cleared first, unconditionally.
- **The callback bound the grant to whatever session was present, not the one that started the flow.** §9 says the state is bound to the *session*; it was bound to the browser. `FlowState` now carries the starting `userId` and the callback refuses a mismatch. Both cookies also carry the `__Host-` prefix wherever `Secure` is on, so no sibling subdomain can plant either one.
- **`account-first` could still create a user through the callback.** The guard lived only on `/start`. It is now on both ends, which matters for a real case: an operator changing `AUTH_MODE` while a flow is in the air.
- **Failed queries logged their bound parameters.** drizzle's `DrizzleQueryError` builds its message from the SQL *and* its parameters — session ids, ciphertext, IVs. `onError` now logs a summary: error name, first line, and the parameterised SQL.
- **`storage-first` minted a new user on every connect.** Signing out and reconnecting left an unreachable user whose connection held a live refresh token nobody could revoke. Connections now store the provider's `account_id` (migration `0002_connection_account_id`) and a returning account is recognised rather than duplicated. The same column tells a reconnect to the same account (keep the id and `rootId`) from a reconnect to a different one (fresh id, `rootId` cleared) — without it a client's notes could sync into a stranger's folder.
- **Provider calls had no deadline**, so a stalled Dropbox could hold `DELETE /api/connections/:id` open forever, contradicting that route's own promise that the row goes either way. `createApp` now wraps the injected fetch with one (`providerTimeoutMs`, default 10 s).
- **Key rotation was a 500.** A row sealed under a retired key is a reconnect, not a fault: `/api/token` answers `reauthorize_required`.
- **A base64url `SECRETS_KEY` passed the boot check and then failed every request**, including `/api/health`, because the validator normalized the alphabet and the decoder did not. They agree now.
- **A failed code exchange was a raw 500** in the user's address bar. A replayed or expired code is ordinary; the user goes back to the app with `connect=failed`.
- **`returnTo` with its own query got a second `?`**, so `connect=ok` became part of the previous parameter's value.
- **Sessions were not sliding**, despite §6 saying so: every user would have been logged out 90 days after their first connect. `currentUserId` now extends the window at most once a day, and swallows a failed extension.
- **`SameSite=Lax` does not cover same-site cross-origin.** A sibling subdomain could `POST /api/token` and read the minted token. `hono/csrf` now checks `Origin` on state-changing methods; the OAuth callback is a GET and is unaffected.
- **Two harness defects**, both of the "a cooperative stub validates the stub" kind: the cookie jar skipped the percent-decode Hono applies, so the flow-cookie assertions worked only for payload lengths that happened to need no escape; and the `node:sqlite` shim's `raw()` collapsed duplicate column names (Node 22 has no `StatementSync.columns()`), which would silently shift every column after the first join. The jar decodes properly, the flow payload is base64url so nothing needs escaping, and the shim now refuses a join rather than answering it wrongly — and rejects instead of throwing, which is what D1 does.

A second review round found four more, three of them introduced by the first round's fixes:

- **The `__Host-` session cookie fell back to the un-prefixed name**, which is exactly the cookie a sibling subdomain can set — so the prefix bought nothing for a signed-out visitor, and the new sliding-expiry write then promoted the planted value to a `__Host-` cookie. Verified end to end: a victim's Dropbox account landed under the attacker's user id and their access token was mintable through the attacker's own session. There is now exactly one cookie name per deployment and no fallback.
- **`account_id` resolved to an arbitrary user when two rows shared it.** In `storage-first` the account *is* the identity, so a second user claiming an already-connected account is now refused with a 409 rather than resolved by row order. `account-first` still permits sharing — the index is deliberately not unique — so the lookup is ordered as well.
- **A grant with no `account_id` fell straight back to minting a user**, reintroducing the orphan the column was added to prevent. Dropbox always sends one; a response without one is now a 502 rather than a guess.
- **The D1 shim's join guard only worked because Node 22 lacks `StatementSync.columns()`.** On Node ≥ 23 it would have taken the `columns()` path and read the already-collapsed row object, answering wrongly again. Both branches now refuse duplicate names.

Three tests were also passing for the wrong reason and have been made load-bearing: the log-leak test asserted against a session id the failing query never bound; the shim's join test compared empty results; and the account-first test's 400 came from the session check, not the guard it named.

A third round found six more, and closed the question the second round had only half-answered:

- **The `no_account_id` guard only caught an *omitted* key.** A JSON `null` or `""` walked past it — and `""` is worse than missing, because it matches every other `""` and adopted two different Dropbox accounts into one user. The parser now accepts only a non-empty string.
- **The same guard was gated on being signed out**, so a signed-in reconnect wrote a null over the account id it already had, setting up the orphan one connect later. It applies unconditionally now.
- **`(provider, account_id)` is now unique** (migration `0003_one_user_per_account`). Two user rows claiming one account is an ambiguity nothing can resolve, and leaving it to a read-then-write meant two concurrent signed-out callbacks could each mint a user. The callback's own check is now belt-and-braces; the loser of the race undoes the user it created rather than leaving one holding a live refresh token. **This is a deviation from the schema comment written in PR 3**, which claimed two users of a shared instance may legitimately connect the same account: in `storage-first` the account *is* the identity, so they cannot, and `account-first` has no use for the second claim either. Revisit in Phase 9 if identity-first sign-in gives a reason to.
- **`account-first` could adopt a *recognised* account** — the second round guarded creating a user but not issuing a session for one the instance already knew, which is the same door.
- **The 409 and 502 rendered raw JSON at a top-level navigation**, the same dead end round one fixed for a replayed code. Every post-exchange failure now redirects with an outcome the UI can read.
- **The shim's `describe()` ran outside `settle()`**, so bad SQL threw where D1 rejects — the very property round one had added.

One thing to remember when reading the suite: the test database is built from the **migration files**, not from `schema.ts`. Mutating the schema alone changes nothing; the constraint has to be mutated where it lives.

A fourth round confirmed the identity model is coherent — every reachable combination of mode, session and claim was executed — and found four smaller things, none of them data loss:

- **`store()` swallowed every error, not just the constraint**, so a D1 blip told a user their own account belonged to a stranger, and logged nothing at all. Only a unique-constraint violation is a conflict now; anything else is a 500 with a log line. (The cleanup that follows was verified safe by fault injection: `minted` can only be true for a user created microseconds earlier, so it cannot delete a pre-existing one.)
- **The session was issued before the connection was stored**, so a failure left a returning owner signed in *and* told the connect had failed. Nobody is signed in until the row is written.
- **Migration `0003` was not safe to re-run.** Applied to a database already holding two users on one account, the `DROP INDEX` committed and the `CREATE UNIQUE INDEX` failed — leaving the table with *neither* index, and every retry then dying on `no such index`. It now drops `IF EXISTS`, de-duplicates (keeping the older connection; the newer user reconnects, and only a token is lost, never a note), and can be run again from any state including the wedged one.
- **Two post-exchange failures still rendered raw JSON** into the address bar. All of them redirect now, with `connect=ok|denied|failed|conflict|signin`.

**Deliberately not done:** AES-GCM is used without additional authenticated data. Binding the connection id as AAD would stop a ciphertext copied between rows from decrypting, but an attacker who can write to `connections` has already lost the user the game. Recorded here rather than done, because the seal/open signature is cheaper to change now than after WebDAV credentials use it too.

**Still open at the end of this PR:** the Dropbox app is not registered, so the OAuth round trip is proven against a scripted `fetch` and against `wrangler dev`, not against Dropbox.

### Data model (Drizzle, D1)
```
users          id, email, email_verified, created_at
identities     id, user_id, provider ('google'|'microsoft'), subject, email, created_at   (account-first only)
sessions       id, user_id, expires_at                      (httpOnly cookie, sameSite=lax, 90-day sliding)
connections    id, user_id, provider, display_name, root_id,
               secret_ciphertext, secret_iv, created_at, last_used_at
               -- secret = { refresh_token } for OAuth, { url, username, password } for WebDAV
```
Secrets encrypted with AES-256-GCM using `SECRETS_KEY` from env (rotate by re-encrypting; key id stored alongside ciphertext). Never log secrets. Never return them to the client.

### Endpoints
| Route | Purpose |
|---|---|
| `GET  /api/auth/login/:provider/start` | `account-first` only. Identity scopes; PKCE + state; redirect to Google/Microsoft |
| `GET  /api/auth/login/:provider/callback` | `account-first` only. Exchange code, read id token/userinfo, link or create user, start session |
| `GET  /api/auth/connect/:provider/start` | Storage scopes; PKCE + state; requires session in `account-first`, creates user in `storage-first` |
| `GET  /api/auth/connect/:provider/callback` | Exchange code, upsert connection with encrypted refresh token, redirect to app |
| `GET  /api/auth/login/:provider/start?link=1` | `account-first` only. Same flow, but callback attaches the identity to the current session's user |
| `DELETE /api/identities/:id` | Unlink a provider; refused if it is the user's last identity |
| `POST /api/auth/logout` | Clear session |
| `POST /api/connections/webdav` | Validate by `PROPFIND` against the URL, store encrypted creds |
| `GET  /api/connections` | List user's connections (no secrets) |
| `DELETE /api/connections/:id` | Revoke at provider where supported, delete row |
| `POST /api/token` | `{ connectionId }` → `{ accessToken, expiresAt }` using stored refresh token |
| `ALL  /api/webdav/:connectionId/*` | Authenticated proxy (see 5.4) |

User identity for v1: a user *is* their first connected account (email from the OAuth identity claim). Multiple connections per user are supported in the schema; the UI can expose that later.

---

## 7. Local store and sync engine (client)

### IndexedDB schema (Dexie)
```
notes        id (uuid), connectionId, path, title, body, frontmatter,
             remoteId?, remoteVersion?, contentHash,
             dirty (bool), deletedLocally (bool), updatedAt
folders      connectionId, path, remoteId?
syncState    connectionId, cursor, lastSyncAt, rootId
opQueue      seq, connectionId, op ('write'|'move'|'delete'|'mkdir'), noteId/path, attempts, lastError
```

### Sync loop (per connection)
1. **Pull**: `changes(cursor)` → for each remote entry:
   - new/updated remote, local clean → fetch content, upsert local, update `remoteVersion`.
   - new/updated remote, local dirty → **conflict** → apply rule from §1.
   - remote deleted, local clean → delete local.
   - remote deleted, local dirty → keep local, mark `remoteId = null` (will be re-created on push).
   - Persist cursor only after the batch commits to IndexedDB.
   - Cold start on a new device is a full scan (`changes(undefined)`); no remote index file. Revisit only if cold start exceeds ~10 s at ~2k notes.
2. **Push**: drain `opQueue` in order. `write` passes `expectedVersion = remoteVersion`; on `ConflictError` → run conflict rule, re-queue. On `AuthError` → request token from backend, retry once, else pause connection and surface in UI. Exponential backoff per op; give up after N attempts and surface.
3. Triggers: app open, tab regains focus, `online` event, 60s interval while visible, Background Sync API when available (best effort), and immediately after a local edit (debounced 2s).

### Folder renames/moves
A remote folder rename or move is applied locally unconditionally, including when notes inside it are dirty: the move is metadata-only and does not conflict with content edits. Dirty notes keep their pending content ops and simply get their `path` rewritten; queued ops that reference old paths are rewritten before push.

### Conflict rule (concrete)
Remote wins the original path. Local content is saved as a new note at `<path minus .md> (conflict <YYYY-MM-DDTHH-mm>).md` with the same frontmatter except a fresh `id`. Both appear in the UI; a small banner links to the pair.

The stamp is UTC and minute-resolution, with the `:` replaced — a colon is illegal in a filename on Windows and rejected outright by several provider APIs, and a copy the provider refuses to store is the lost edit this rule exists to prevent. UTC so two devices in different zones name the same conflict the same way rather than producing two copies that look hours apart and unrelated. A minute is not unique enough on its own, so a second conflict on the same note inside one minute gets `-2`, `-3`, and so on; the comparison is case-insensitive, because Drive, Dropbox and macOS all are. The name is deliberately **not** slugified: the copy has to be recognisable as the note it came from and sort next to it.

Implemented in `packages/core/src/sync/conflicts.ts`.

### What the loop above left open, and how the engine answers it

The branch table is the specification; these are the cases it does not mention, each decided in the direction that cannot lose an edit. They live in `packages/core/src/sync/engine.ts`.

- **A file that is not a note is ignored**, as is anything at a hidden path. The app owns the folder but not everything in it: a PDF the user dropped beside their notes would be corrupted by being read as markdown and written back, and `.notesapp.json` is our own bookkeeping. Two separate checks, because the marker happens to satisfy both and would otherwise hide the loss of either.
- **Same bytes, new version → adopt the version, do not conflict.** This is our own write coming back, or two devices that saved the same thing. Keeping the old version would make the next push send an `expectedVersion` the remote has moved past, manufacturing a conflict over a file that already agrees with us.
- **A move reported as a deletion plus an entry** — which is what Dropbox and Graph do — must not act on the deletion. Applied after the move it deletes the note outright, and which order they arrive in is the provider's business. A remote id the batch says is somewhere *else* has been moved, not deleted.
- **A deletion is settled by a write-back only if the write pointed the note at a *different* file.** A note is written back by an entry about the very file a deletion names all the time — our own push echo arriving beside the other device's delete, which is what a rename here plus a delete there looks like. Reading "this batch mentioned the note" as settled drops the deletion for ever and leaves the row pointing at a file that no longer exists; the next queued move for it can then never succeed, and the ordered queue strands every op behind it. Asked of the *file*, the two cases separate cleanly. A deletion carrying no id names no file, so there it stays a question about the note, answered the way that cannot lose one: keep it.
- **Alive elsewhere, not alive anywhere.** A batch routinely carries the state of a path before it was removed: our own write coming back, and then the other device's deletion of that same file. Reading the earlier entry as evidence the file survived drops the deletion — and a deletion dropped here is dropped for ever, leaving a row that points at a file nobody will ever mention again. The rule that entries are deduplicated to the last one about a thing applies here too: only an entry at a different path, or a later one at this path, says the file is still there.
- **A move may or may not change the version**, so the path is followed on both routes through the decision. Dropbox's `rev` survives a move; OneDrive's `eTag` does not.
- **A deletion that names the file is believed.** The rule above it — that a folder alive elsewhere in the batch means its children are not deleted — exists for a deletion carrying nothing but a path, and must not be applied to one carrying an id: the provider knew the file well enough to identify it, and "some folder above it is also in this batch" is not evidence against that. A deletion dropped here is dropped for ever, because the cursor moves on and nothing mentions it again.
- **A folder move is addressed by where the folder is now.** Renaming `A` and then dragging `A/sub` out of it lands as two entries in one window, and the second decision is reached after the first has already rebased everything under `A`. Naming the folder's pre-batch path moves nothing at all and says nothing about having failed, so the notebook keeps a position the remote abandoned until the next cursor reset — and a write into it then fails for ever. Same rule as for notes, applied to the one decision-maker that was still asking the store alone.
- **A folder move gets the folder in its way out of the way first.** Two folders cannot share a path — the store keeps one row per path — so a move onto an occupied one overwrites that row and merges both notebooks' notes into whichever name survives. Which of the two the engine does depends on what the rest of the batch says. If the batch also reports the occupant deleted (the user deleted `Archive` and renamed `Archive 2024` onto its name), it is deleted first, which is the order the remote did it in and lets the store cascade its subfolders. If nothing says it is gone, it is on its way somewhere else — two drags in one window — and it is moved aside under a conflict name, exactly as a note in the same position is, for the entry that says where it went to move it on from there. Deleting it on suspicion would take notes nobody asked to lose.
- **Which folder is in the way is a question about the batch too.** By the second claim on a path, the folder standing there may be one an earlier decision moved in. Reading the occupant off the store answers with the one that used to be there — and if *that* one is the one the batch deletes, the delete takes the newcomer's notes instead.
- **A folder created and deleted inside one window is forgotten.** Both halves arrive in the same batch, and the store — asked as it was before any of it — has never heard of the folder. Without counting what the batch itself has just made, the notebook sits in the sidebar with nothing behind it.
- **A remote folder delete keeps the dirty notes inside it**, detaching them so the next push re-creates them, and takes the clean ones and every subfolder with it. Which of the two a note gets is decided against the batch as well: a conflict earlier in the same batch hands the local edit to a copy and leaves the note clean, so it goes with the folder rather than surviving it. The folder is the user's remote layout; the note is their writing, and losing the second to a change in the first is not a trade worth making. The store does the cascade in one transaction, because a provider that reports only the folder gives the engine nothing else to send.
- **Decisions are reached against the store as it was, and applied in order**, so a later decision can be about a note an earlier one has already taken away. A provider that reports a folder deletion recursively produces exactly that — the folder, and then each file that was inside it. The engine tracks what the batch has already removed and says nothing twice; a note that turns up again afterwards (moved out of the folder in the same batch, or a file deleted and re-created at one path) is written back under the id it already had, so the user keeps one note rather than watching one vanish and another appear. Belt and braces: `delete-note` and `detach-note` for an id the store does not hold are defined as no-ops, because a batch that rejects is a batch that is retried for ever — the cursor moves only with it, so a single unanticipated ordering would leave the user with a sync that never recovers on its own.
- **One note per path, and one `remoteId` per note, once the batch has been applied.** A note of ours can be sitting exactly where a remote one is about to land — two devices both writing an `Untitled.md` offline is the ordinary way to get there. Left alone, the two share a path: the sidebar shows one row twice, the queued write for ours eventually lands on the other one's file, and both rows end up carrying one remote id — after which `noteByRemoteId` only ever hands back one of them and the other is stale for ever. So ours moves aside first, under the name a conflict copy would get, because that is what it is. That applies whether or not it has been pushed: a pushed note has no claim to the path either, since the remote has something else there, and it keeps its `remoteId` so the entry saying where its file went puts it back. Duplicates are therefore possible *during* a batch, which is why the store must not put a unique index on the path, and must not make room by deleting what is there.
- **Whether a path is occupied is a question about the batch, not the store.** By the time a change runs, an earlier one may have moved the occupant out, deleted it, conflicted it onto the remote's path, or carried it off with a folder — and one the store says is nowhere near may be about to be carried *in* by a folder move, which re-lists no children, so nothing else in the batch mentions it. Asking the store alone either moves a note that has already gone — which fails the batch, and a failed batch is retried for ever — or leaves two notes on one path. So does asking it what names are free: the same folder move can bring in the exact name a conflict copy was about to take. More than one note can be in the way of a single file, and each gets a name of its own.
- **A displacement carries the note's queued ops with it**, exactly as a folder move does. A queued `move` is the user's rename and its target is the very path the remote has just taken: left pointing there it conflicts on every push and can never succeed, and since the queue is ordered and a dead op stops the drain, every later op for every other note is stranded behind it.
- **A file can be gone by the time we read it.** `changes` and `read` are separate round trips on every provider, so a file the feed named can be deleted in between — the other device editing a note and then deleting it inside one cursor window is enough. The entry is skipped rather than thrown on: unwinding the pull leaves the cursor where it was, so the next attempt fetches the same batch and dies the same way, and push never runs either because `sync` stops on a pull that is not `ok`. Nothing is imported and nothing of ours is moved aside; the deletion arrives as an entry of its own. Only "it is not there" is survivable — a refused or broken read is a batch nobody has decided, and moving the cursor past it would skip the changes for good.
- **A batch sees the notes it has itself created.** A file created, deleted and re-created at one path inside one cursor window arrives as three entries, and each of the last two has to know what the ones before it did: the deletion is about a note only this batch has made, and the second file lands on a path only this batch has filled. The store can say nothing about either — none of it has been applied — so the decisions already taken are read back as rows.
- **A path can be reused.** A note is identified by `remoteId`; the path is a fallback, and it is what lets a note created here be recognised when its own first push comes back. The one note the fallback must not claim is one whose own remote copy is alive elsewhere in the batch: that note has been moved and the path merely reused, and claiming it would hand two notes each other's contents. A deletion is matched the other way about — by path only when it carries no id at all, since a deletion whose id we have never seen is about a file that is not ours.
- **An id in a file is adopted only if nothing else holds it.** The `id` in frontmatter is what makes two devices agree which note a file is, so it is adopted by default. But duplicating a file is an ordinary thing to do in a folder the user can see, and the copy carries the original's id: adopting it blindly writes the copy over the note it came from, unpushed edits included, and leaves the two files fighting over one row on every sync afterwards. The second file to arrive is a new note.
- **One entry per thing, keeping the last.** Dropbox documents that a path may appear more than once in a batch and that the last entry is the current state. Decided twice against the same pre-batch store, one edited note produces two conflict copies wanting the same path — which the store cannot tell apart, and the push then writes one over the other and gives them one remote id. Deletions are keyed by path and live entries by id, because a file deleted and another created at that path in one batch is two things happening, not one thing said twice.
- **A rename need not re-list what is inside it.** The children's bytes did not change, so a provider may report a renamed folder as the folder at its new path plus the old child paths as deleted, with nothing at all about where the children went. The only thing left saying those notes are alive is that a folder above them is: the deletion is checked against the whole batch by way of every ancestor, not just the path itself.
- **A conflict copy is named against the folder the note ends up in**, not the one it came from, and avoids every name the batch is bringing in, every name already in the store, and every name the batch has already chosen — one entry can need both a displacement and a conflict copy, and both are named from the same path. Two devices syncing on the same interval conflict inside the same minute, so the copy one of them made arrives in the very batch that decides to make the other; landing on the same name overwrites the edit the copy exists to save. Naming it against the old folder is the same bug in a different direction — the old folder may be one this batch is deleting.
- **A full scan reconciles, folders included — and only once it is all in.** A scan says what exists, never what was removed, so after a `CursorResetError` every note deleted while the cursor was dead would come back, and a notebook deleted then would sit in the sidebar for ever with nothing behind it. Notes and folders carrying a `remoteId` the scan did not mention are treated as remotely deleted; anything never pushed is left alone. Two things make this the most destructive rule in the file. It runs on the last page only, because no page before it has seen everything and reconciling against one would delete nearly the whole store — and the pages after would put a note back at each path, so the app would look right and every note would be a different note. And it exempts whatever the same batch has just re-established: a file replaced at one path while the cursor was dead leaves the row carrying the *old* `remoteId`, which a scan that only saw the new one never mentions.
- **A scan sweeps up only what the batch has not already settled.** Reconciling names the notes a scan never mentioned, and a `delete-folder` in the same batch names none of the notes it cascades over — so without asking where each note stands once the batch has run, the sweep deletes them a second time.
- **The app folder is never a folder row, and never a folder change.** Several providers report the root as an entry of its own — Graph's `delta` returns the root item. There is nothing above it to hold a row, and a row for it would be reconciled away after the next cursor reset as a folder the scan did not mention. Since every path is within the root, that one `delete-folder` is every note on the device. Guarded where the row would be made and again where it would be deleted.
- **A deletion of the app folder itself is ignored.** An adapter that reported the root by mistake would otherwise wipe every note on the device in one batch, and if the folder really is gone it is the connection that needs attention, not the notes.
- **A note that changed while it was being pushed stays dirty.** The outcome handed to the store carries the exact bytes that were sent, and the store clears the flag only if the note still holds them. Otherwise the last thing the user typed is marked as saved and never sent.
- **A failed push stops the queue rather than stepping over it.** The queue is ordered because later ops depend on earlier ones — a write into a folder whose `mkdir` failed would land nowhere, or resurrect a folder on a provider that creates missing parents. An op that has failed five times is surfaced rather than retried.
- **Same bytes, new version is not a conflict on the push side either.** An interrupted push looks exactly like one: the write reached the remote and the store could not be told before the tab closed, so the op is still queued carrying a version the remote has moved past. Conflicting would hand the user a copy of the note they already have.
- **The op that hit a conflict is finished, not re-queued.** Its content is preserved in the copy; replaying it would overwrite the remote with the very bytes the user has just been handed a copy of. Only a `write` is answered this way: a `move` that finds its target occupied and a `mkdir` that finds a file in the way carry no two versions of anything, and resolving them would point the note at somebody else's file. They fail, and stop the queue like any other failure.
- **A push that finds nothing at the path asks whether the file merely moved.** `write` is addressed by path, so a file renamed remotely reports exactly what a deleted one reports, and §7's answer to a deleted file — re-create it — would leave the user with two notes where they had one. The engine reads by `remoteId` first; if the file is gone it re-creates, and if it is still there it asks *who* renamed it. A remote rename is left for the next pull to rebase. A local one — the user edited and then renamed, so the queue is a write and then a move — can never resolve itself: no pull will move a note over a rename the remote has not heard of, and the ordered queue cannot reach the `move` while the `write` in front of it is failing. The queue is what tells the two apart, so it is asked, and the rename is performed there and then.
- **A move whose file is gone is finished, not retried.** Nothing will make it succeed, and failing it blocks the ordered queue for ever over a rename — the least of what the user has waiting behind it. The note keeps its contents, and the pull that reports the deletion cuts it loose or takes it away.
- **A transient failure is a status, not a rejection.** Offline, a 500, a store that could not commit: the batch rolled back and the cursor did not move, so `pull` answers `retry` exactly as `push` does. That covers every store call, not just the batch — reading the cursor and reading the queue are store calls too. Rejecting instead would make every caller wrap `sync()` in a `try` to discover something `status` exists to tell them, and one that forgot would take the app down on a flight.
- **A locally deleted note keeps its row until the remote copy is gone, and every read sees it.** The queued `delete` carries a note id and nothing else; the `remoteId` it needs lives on the row, so the row *is* the tombstone. A store with a `deleted` flag and filtered indexes is a natural reading of "every live note", and it loses a note the first time one is deleted here and edited on another device: the pull cannot see the row, mints a second note at that path, and the queued delete then removes the file that was just imported. Where both happen in one window the delete wins — the row is written back by the pull and purged by the op behind it. That is a decision, not an accident: the delete is something the user did, and the remote change may be their own from the other device.
- **A push is addressed by where the note is now.** A pull between queueing an op and running it rebases the note and leaves the op's own `path` behind. Invisible where `remoteId` identifies the file, and the whole address where it does not (WebDAV, Phase 5).
- **A move with no target fails rather than being marked done.** It is a store that lost the column, not a move with nothing to do, and completing it would discard the user's rename with nothing said anywhere.
- **Nothing is reported that did not happen to the user.** A deletion that matches no note and no folder we hold — a PDF beside the notes, a file never imported — is not news, and counting it puts a number in front of someone for an event that was never about them.
- **A folder move clears the notes in its way, not just the folder.** A cascade keeps a dirty note and merely cuts it loose, so a deleted folder can leave notes behind at their paths with no folder row above them. Moving another folder onto that path then drops its notes on top of theirs: two rows at one path, which the sidebar shows twice and which the next push has overwrite each other for ever. The local note is displaced to a conflict copy — the remote keeps the path — at whatever depth under the destination it sits.
- **A folder deletion says which folder, not which path.** Two drags in one cursor window name one path and mean two folders: delete `A`, rename `B` onto `A`, delete `A`. Matched by `remoteId` where the provider gives one and by the row that was at the path where it does not, and answered with the position that folder ends up at once the decisions in front of it have been applied. A deletion dropped here is dropped for ever, because the cursor moves on and nothing says it again.
- **Two files deleted at one path are two deletions.** Keyed by `remoteId` rather than path, so a file replaced and then removed inside one window does not fold into a single event that lets go of only the second.
- **An entry is not matched by path to a note the batch has already moved.** A folder rename carries every note under it and the feed says one word about the whole subtree, so the store still shows the note at its old path. A different file arriving there would otherwise be written into it, while its own file goes on existing under the new name. A note the batch merely *removed* is still matched: it has nothing of its own left and becomes the arriving file, which is what keeps one note rather than two when a path is reused.
- **A `move` that reports not found asks which end was missing.** A provider answers the same way for a file that is gone and for a destination folder that was never created, and a note dragged into a notebook made on this device hits the second every time — nothing queues a `mkdir` for a folder that has only ever been moved into. The folder chain is created and the move retried; only a genuinely missing source finishes the op.
- **A conflict discards the losing edit's queued write.** That op carries the content the copy now holds, and the note itself holds the remote's bytes. Replaying it puts the remote's own content back under a new version, which every other device pulls as a change that changed nothing — and which can lose a race against a real edit made in between. The user's rename is left queued: the conflict rule is about content.
- **A rescan names the outermost vanished folder only.** `delete-folder` cascades, so naming a nested one as well is a second delete of a row the first has already taken.
- **A rescan names a vanished folder by where its row ends up.** A scan is one batch like any other, and a `move-folder` decided in front of it has already rebased the row; naming the pre-batch path deletes nothing and leaves the notebook the remote no longer has in the sidebar under its new name.
- **Every batch-aware question about notes includes the ones the batch has moved by name.** A folder is not the only thing that carries a note somewhere: a `move-note` brings one in from anywhere at all, and its row is still at the old path in the store. Missing it means nothing is displaced when a second file lands on the same name — two rows at one path, which the sidebar shows twice and the next push has overwrite each other.
- **A write that finds nothing makes the folder before re-creating the file.** A provider answers not found for a missing file and a missing parent alike, and the second is the ordinary case of a notebook deleted on another device while a note inside it had unsaved work: the pull keeps that note and cuts it loose, leaving nothing on the remote above it. Without this the write fails identically on every attempt and the ordered queue strands every op behind it, for every note.
- **A cascade leaves the notes it keeps a notebook to be in.** `delete-folder` takes the folder rows on the way down but not the dirty notes, so the rows a surviving note needs are re-established — at the end of the batch, because whether a note is still there is not known until the batch is over.
- **A rename the user has queued is not undone by our own echo of it.** The feed cannot say whose rename an entry describes; the queue can. Moving the row back undoes what the user just did in front of them and frees the path they renamed *to*, so a file arriving there in the same batch is imported rather than displaced and the queued move then conflicts on that path for ever. The version is still adopted; only the path is left alone. `followTheRename` asks the same question from the push side, and only about a queued move whose target is where the note now is.
- **A push conflict over a file another note already holds is not that note's conflict.** The path is simply taken, by a file whose own row is elsewhere because its rename has not been pulled yet. Adopting it would give two rows one `remoteId` — `noteByRemoteId` hands back one of them and the other is stale for ever. The note moves aside instead and its write is retried where it now is.
- **A queued rename onto a path the remote will not give up lands beside it.** A `move` is not a `write`, so the conflict rule has no second version to reconcile, and nothing will ever free that name: left queued it fails on every attempt and strands every op behind it over a rename. The remote keeps the path and the rename takes a conflict name, where the user can see what became of it.

**Known limit, and where it is fixed.** A note that is renamed remotely *while it holds unpushed edits* is recognised as a rename only on providers whose version survives a move — Dropbox's `rev` does. Where it does not (OneDrive's `eTag`, WebDAV), the engine cannot tell the rename from a remote edit and takes the safe branch: the remote keeps the path and the local edit becomes a conflict copy. Nothing is lost, but the user gets a copy for a rename they did not make. Closing it needs the note to remember the bytes it last synced — a hash on `SyncNote`, compared against the remote's content before deciding — and that belongs with Phase 3, where the first such provider arrives.

### Editor

Two modes over one markdown string. Default is rich text; a toolbar/shortcut toggle (`Cmd/Ctrl+E`) switches to raw markdown. The mode is remembered per note and there's a global "default mode" preference.

**Rich mode:** Milkdown (ProseMirror on top of a remark AST). Chosen because its document model *is* the markdown AST: parse/serialize are the core of the editor rather than an add-on, unsupported syntax stays in the tree instead of being dropped, and the same remark pipeline can serve as the normalizer in `core`. Presets: `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`; plugins: slash, tooltip (inline formatting), history, listener, clipboard. React via `@milkdown/react`. Known trade-offs: smaller community, mostly single-maintainer, React bindings are functional rather than polished, majors have had breaking changes — pin the version. Fallback if maintenance state or React integration proves a blocker: Tiptap with its official markdown extension, accepting a lossier serializer and relying harder on the fidelity suite.

**Raw mode:** CodeMirror 6 with `@codemirror/lang-markdown`, same autosave path.

**Packaging:** the presets and plugins are taken from `@milkdown/kit`, the aggregate package Milkdown publishes, rather than as a dozen separately versioned dependencies. Same code, one version to pin — which is what "pin the version" was asking for.

**Menus.** The slash menu (`/`) and the inline formatting toolbar are ProseMirror plugin views written in React, mounted through `@prosemirror-adapter/react` — the adapter Milkdown's own React examples use. Both offer only constructs the fidelity suites already cover, so nothing reachable from a menu can put something in a note that the file format cannot hold. Picking a command is a user edit like any typed one: it removes the `/query` the user typed and marks the note dirty, which is the point.

**Empty paragraphs become `<br />`.** Markdown has no way to say "a blank paragraph here" — blank lines are separators, not content — so Milkdown writes an HTML break for one and reads it back as an empty paragraph. It is the one place the editor puts something in a file the user did not type. It stays because it is a bijection and loses nothing in either direction: stripping it instead would delete a `<br />` that came from the user's own file, which is the worse failure. Pinned by a test in `apps/web/tests/rich.test.ts`.

**Not `@milkdown/plugin-listener`.** Its `markdownUpdated` is the obvious way to hear about changes, but it debounces on a timer of its own and, more importantly, hands over a markdown string with no way to tell whether a person or the app caused it. That is exactly the distinction the dirty rule is made of. A small ProseMirror plugin — the one in `editor/dirty.ts`, which reads transaction metadata — answers it directly, and the serialization happens where the answer is already known.

**Source-of-truth rules (these matter more than the editor choice):**
- The note record stores `body` as a markdown string. Neither editor persists its own document model.
- Frontmatter is stripped before the body reaches either editor and re-attached on save. Editors never see it.
- Switching modes serializes the current editor to markdown, updates `body`, and loads the other editor from that string. There is exactly one dirty-tracking path.
- A note becomes dirty only on an editor transaction that changes the document, never on load, mode switch, or re-serialization. Opening a note in rich mode and closing it must not rewrite the file. This prevents normalization churn on notes authored by other tools.
- On first *user* edit in rich mode, the whole file is re-serialized through remark-stringify, so some normalization (list markers, emphasis style, blank lines) is accepted at that point. Configure `remark-stringify` for the most conventional output: `bullet: '-'`, `emphasis: '*'`, `strong: '*'`, ATX headings, `fences: true` with language tag. Use the identical options in `core`'s normalizer so editor output and test expectations agree.
- Anything the rich editor can't represent (raw HTML blocks, footnotes, unknown syntax) must survive round-trip as an opaque block rather than being dropped. If the parser can't guarantee that for a given note, open it in raw mode with a banner explaining why. Checked per note against the editor's own parser and serializer before the user can type, because ProseMirror's schema is a narrower model than mdast and is where a construct would actually be dropped — `core`'s remark suite cannot see that. Nothing in the corpus fails it today.
- A body arriving at a mounted editor is loaded only when it is genuinely new and did not come from that editor. Autosave is debounced, so the note's stored body is always a little behind what is on screen; reloading the editor from it — when the save echoes back, or on any re-render that happens to carry the same stale prop — silently deletes everything typed since. This is the rule with the sharpest teeth in the editor layer and it has its own tests.

**Fidelity test suite** (`packages/core/tests/markdown/roundtrip.test.ts`): a corpus of markdown fixtures — CommonMark spec samples, GFM tables/task lists, nested lists, code fences with languages, hard breaks, HTML blocks, files from Obsidian/iA Writer/Bear exports. For each: `serialize(parse(md))` must equal `md` after both sides pass through the same normalizer, and `parse(serialize(parse(md)))` must be structurally identical to `parse(md)`. Because Milkdown uses remark, `core`'s `parse.ts`/`serialize.ts` wrap the same remark plugins the editor is configured with, so this suite exercises the editor's actual pipeline headless in CI. Add a second layer that mounts Milkdown in jsdom/Vitest browser mode and round-trips through the editor instance itself.

Title is derived from frontmatter `title`, else the first `# ` heading, else the filename.

---

## 8. PWA specifics
- `vite-plugin-pwa` in `generateSW` mode to start (switch to `injectManifest` only if a custom worker becomes necessary): precache app shell, `NetworkFirst` for `/api/*`, `NetworkOnly` for provider API origins, `registerType: 'prompt'` with an in-app "update available" toast.
- Manifest generated by the plugin: standalone display, icons, `share_target` (later) for "share to notes".
- Dev: enable `devOptions.enabled` so the SW runs under `vite dev`; `wrangler dev` serves the API on `:8787` and Vite `server.proxy` forwards `/api` to it so cookies stay same-origin. Prod is genuinely same-origin (SPA served as Worker static assets).
- All note data lives in IndexedDB; the app boots and renders from local state before any network call.
- Tokens: keep provider access tokens in memory (React state) with a copy in IndexedDB `syncState` so a reload doesn't force a backend round-trip. Never in localStorage.
- Installability is a checklist the browser applies silently — a missing 192px icon or a bad `start_url` and the install option simply never appears, with nothing in the build to say why. The manifest and Workbox options live in `apps/web/pwa.ts` rather than inline in `vite.config.ts` so that checklist can be a test (`tests/pwa.test.ts`), down to reading each icon's real dimensions out of its PNG header.
- With `registerType: 'prompt'` the worker does not claim the first page load, by design: the page that registered it keeps running the build it was served, and the next navigation is the first one the worker controls. So "works offline" means from the second visit onwards, which is the only thing it could mean — the first visit is the one that downloads the app.

---

## 9. Security checklist
- PKCE + `state` on every OAuth flow; state bound to the session cookie.
- `SECRETS_KEY` only in server env; secrets table encrypted at rest.
- WebDAV proxy: allowlist methods, reject paths that escape the configured base URL after normalization, strip hop-by-hop headers, 30s timeout, 20 MB body cap.
- WebDAV proxy SSRF hardening (on by default; protects operators who expose their instance to the internet): HTTPS only; resolve the host and reject private/loopback/link-local/cloud-metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, fc00::/7, ::1); reject IP-literal hosts; re-validate on redirect (or disable redirects); per-user rate limit and daily byte budget. Self-hosters can relax the private-range rule via `WEBDAV_ALLOW_PRIVATE=true` for LAN Nextcloud.
- CSP: `connect-src` limited to self + `www.googleapis.com` + `graph.microsoft.com` + `*.dropboxapi.com`.
- Disconnect revokes at the provider (Google `revoke`, Dropbox `auth/token/revoke`; Graph has no per-app revoke — document that the user removes it from their Microsoft account page).

---

## 10. Phased plan

Each phase ends with something runnable. Don't start the next phase until the current one's checklist is green.

### Phase 0 — Scaffold (½ day)
- [x] pnpm workspace with `apps/web` (Vite + React + TS), `apps/api` (Hono + TS), `packages/core` (shared TS, no framework deps); shared ESLint/Prettier/tsconfig base
- [x] TanStack Router with a single `/` route plus `/auth/callback` landing route
- [x] `wrangler.toml` with D1 binding + `[assets]` for the SPA; Drizzle schema + first migration; `pnpm db:migrate` (local and remote)
- [x] `packages/core/src/config.ts` exporting `APP_FOLDER_NAME = 'skysa-notes'`, `MARKER_FILE = '.notesapp.json'`, `MARKER_SCHEMA_VERSION = 1`; `marker.ts` with `buildMarker()` / `parseMarker()` and the read-only-on-newer-version rule
- [x] `vite-plugin-pwa` wired, manifest generated, PWA installable (manifest, service worker, and 192/512 + maskable icons all present and served; not yet confirmed with a Lighthouse run in a real browser)
- [x] Vite dev proxy → `wrangler dev` on `:8787`; single `pnpm dev` runs both
- [ ] Register provider apps (Google Cloud, Entra, Dropbox App Console) with the name `skysa-notes` and the callback URLs for local + prod — **operator task, not done in-repo.** `ENABLED_PROVIDERS` lets an instance run with only the providers it has registered; `webdav` needs no registration at all
- [x] Env validation (`zod`) for all provider client ids/secrets and `SECRETS_KEY`

### Phase 1 — Local-only notes (2–3 days)
- [x] Dexie schema, notes/folders CRUD in IndexedDB
- [x] Markdown parse/serialize wrappers in `core` + round-trip fidelity suite (write this before wiring the editor)
- [x] Sidebar folder tree, note list
- [x] Rich editor (Milkdown: commonmark + gfm presets, slash, tooltip, history, listener) via `@milkdown/react`; pin version — pinned at 7.22.1. `plugin-listener` is deliberately not used: see §7
- [x] Raw editor (CodeMirror 6), mode toggle, per-note mode memory, "dirty only on real edits" rule verified by test
- [x] Frontmatter strip/reattach, slug filename logic
- [x] Works fully offline; installable

### Phase 2 — Backend + Dropbox end to end (2 days)
Dropbox first: simplest API, proper conflict semantics, long refresh tokens.
- [x] Contract test suite + in-memory fake provider (write this before the first adapter, as the round-trip suite was written before the editor)
- [x] Auth start/callback, sessions, encrypted connections table, `/api/token`
- [x] `DropboxProvider` implementing the full interface
- [x] "Loose notes" sidebar row, resolving the §12.6 ship blocker. Split out of the sync-engine PR because it depends on nothing the engine adds, and the engine is large enough on its own.
- [x] Sync engine: pull, push, cursor persistence, opQueue (`packages/core/src/sync/`). The `SyncStore` port is defined here and implemented over Dexie in the UI PR below, where it registers against `tests/sync/storeContract.ts`.
- [ ] UI note, carried from the PR above: `useNote` reads `db.notes.get(id)`, which returns a tombstone, so a note deleted remotely while it is open stays fully editable in the right pane after the list and sidebar have moved on. Harmless until the engine runs in the browser, which is the PR below.
- [ ] UI: connect one account (replace/disconnect only, no multi-account), sync status indicator, manual "sync now"

### Phase 3 — OneDrive (1 day)
- [ ] `OneDriveProvider` (approot, delta, If-Match)
- [ ] Contract tests pass
- [ ] Record the bytes a note last synced (a hash on `SyncNote`) so a remote rename is not read as a remote edit. OneDrive is the first provider whose version does not survive a move; until then a rename of a note holding unpushed edits produces a conflict copy the user did not need. See §7, "Known limit".

### Phase 4 — Google Drive (1–2 days)
- [ ] `GDriveProvider` (drive.file, folder creation/discovery, changes API, parent→path mapping)
- [ ] Contract tests pass
- [ ] Document the Google OAuth consent-screen verification path (non-restricted scopes) for operators who want to leave Testing mode

### Phase 5 — WebDAV (1–2 days)
- [ ] `/api/webdav/*` proxy with allowlisting
- [ ] `WebDavProvider` with sync-collection detection and PROPFIND fallback
- [ ] Decide what `remoteId` means where it *is* the path. A move changes it, so a note cannot be followed across one by id — the engine's fallback is the path, and its `live` check (§7) leans on ids surviving a move. `tests/providers/contract.ts` already has the `stableIds` escape hatch; the engine needs the matching answer, and a rename that duplicates a note is the failure to test for.
- [ ] Test against Nextcloud (docker) and a plain SabreDAV/Apache mod_dav

### Phase 6 — Sync hardening (1–2 days)
- [ ] Conflict rule implemented and tested for every provider
- [ ] Rename/move handling, folder rename cascading
- [ ] Retry/backoff, poison-op surfacing, "reset connection" (re-scan from scratch)
- [ ] Multi-device soak test: two browsers, edit same note offline, reconnect

### Phase 7 — Polish
- [ ] Search (local full-text over IndexedDB; MiniSearch)
- [ ] Rich-editor polish: image paste (once attachments are in scope), find/replace, outline panel
- [ ] Keyboard shortcuts, command palette
- [ ] Multiple connections per user (schema already supports it)
- [ ] Share target, export/import zip

### Phase 8 — Public repo + self-hosting (1–2 days, after Phase 6)
- [ ] `LICENSE` (AGPL-3.0), `TRADEMARK.md`, `CLA-individual.md` (adapted Apache ICLA + Harmony reciprocity clauses), `CLA-entity.md` (adapted Apache CCLA, held until needed), `CONTRIBUTING.md` explaining the CLA and why it's a grant not an assignment, `CODE_OF_CONDUCT.md`
- [ ] `contributor-assistant/github-action` wired to `CLA-individual.md`, blocking merges from unsigned contributors; signatures stored in a `cla-signatures` branch or separate repo
- [ ] `docs/self-hosting.md`: Cloudflare account, `wrangler login`, D1 create + migrate, `wrangler secret put` for each key, registering Google/Entra/Dropbox apps named `skysa-notes` with callback URLs, expected "unverified app" screens, custom domain
- [ ] `pnpm setup` script that prompts for provider credentials and writes secrets; `pnpm deploy` = build web + `wrangler deploy`
- [ ] Verify a clean clone deploys end to end on a fresh Cloudflare account
- [ ] GitHub Actions: lint, typecheck, contract tests, round-trip suite, `wrangler deploy --dry-run`; changesets for versioning, tags `vX.Y.Z`
- [ ] Repo hygiene: branch protection on `main`, Dependabot (npm + actions, weekly, grouped), issue templates, Discussions for support, `SECURITY.md` with private vulnerability reporting, `.dev.vars.example`

### Phase 9 — Account-first identity mode (optional, 2–3 days)
Only needed for instances where sign-in should be separate from storage (shared instances, users who switch providers). `storage-first` remains the default.
- [ ] `account-first` auth: Sign in with Google and Microsoft via Arctic; `identities` table; automatic merge-by-verified-email; explicit in-session link (`?link=1`) and unlink; Settings page listing linked providers; tests for: verified-email auto-link, unverified email creates new user, identity already attached to another user is refused, last identity cannot be unlinked
- [ ] Google and Entra registrations updated with `openid email profile` and the `/auth/login/*` redirect URIs (distinct from `/auth/connect/*`); Google sign-in button branding guidelines followed
- [ ] Verify the `/auth/login/*` routes are not mounted in `storage-first`, and that WebDAV routes are absent from the built Worker when `webdav` is not in `ENABLED_PROVIDERS`
- [ ] Abuse controls for shared instances: per-user rate limits on token minting and connection changes, connection cap
- [ ] Account deletion: revoke provider tokens and delete all of the user's rows in one action

---

## 11. Repo layout

```
pnpm-workspace.yaml
package.json                  # root scripts: dev, build, test, lint, db:migrate
apps/
  web/                        # Vite + React SPA
    vite.config.ts            # vite-plugin-pwa, /api proxy
    src/
      main.tsx routes/ components/
      editor/                 # RichEditor (Milkdown), RawEditor (CodeMirror), ModeToggle, shared autosave hook
      store/                  # Dexie db, notes.ts, folders.ts
      sync/                   # scheduler.ts (triggers, visibility, online events) — wraps core engine
      api/                    # typed client for apps/api
  api/                        # Hono on Cloudflare Workers
    wrangler.toml             # D1 binding, [assets] → ../web/dist
    src/
      app.ts                  # createApp(options) — library export, no env access
      worker.ts               # default Worker entry: createApp with self-host defaults from env
      routes/
        login.ts              # /auth/login/:provider/* (identity, account-first mode)
        connect.ts            # /auth/connect/:provider/* (storage)
        connections.ts        # /connections, /connections/webdav
        token.ts              # /token
        webdav.ts             # /webdav/:connectionId/*
      db/                     # drizzle schema, client, migrations
      crypto.ts               # AES-GCM helpers
      identity/               # IdentityProvider interface, google.ts, microsoft.ts (Arctic)
      oauth/                  # storage OAuth: gdrive.ts onedrive.ts dropbox.ts pkce.ts
      webdavProxy.ts
packages/
  core/                       # zero framework deps; runs in browser, Node, and Workers
    src/
      config.ts               # APP_FOLDER_NAME, MARKER_FILE
      providers/
        types.ts              # StorageProvider interface, errors
        gdrive.ts onedrive.ts dropbox.ts webdav.ts fake.ts
      sync/
        engine.ts conflicts.ts
      markdown/
        frontmatter.ts slug.ts
        parse.ts serialize.ts # remark pipeline (same plugins/options as the editor) + normalizer, used by editor and tests
    tests/
      providers/contract.test.ts
      markdown/roundtrip.test.ts
      sync/*.test.ts
docker/nextcloud-compose.yml  # WebDAV test target
```

Dependency rule: `core` imports nothing from `apps/*`. `web` and `api` may import `core`. The WebDAV adapter in `core` takes a `fetch`-like function so it can point at the proxy in the browser and at the server directly in tests.

---

## 12. Resolved decisions (formerly open questions)

1. **App folder name:** `skysa-notes`, exported as `APP_FOLDER_NAME` from `packages/core/src/config.ts`. It governs the folder Google Drive and WebDAV create. OneDrive and Dropbox derive their app-folder name from the provider registration, so those registrations must be named to match; Dropbox's name is immutable after creation, so if the constant changes before launch, re-create the Dropbox app.
2. **Remote folder renames apply even when contained notes are dirty.** Metadata-only; see §7.
3. **Single connection per user until Phase 7.** Schema supports many; UI exposes one.
4. **Hosting: Cloudflare Workers** for API + static SPA, D1 for the database. See §6.
5. **Cold start is a full scan.** No remote index file. Revisit if cold start exceeds ~10 s at ~2k notes.
6. **Every note the app creates lives in a notebook; the root is not one.** The sidebar lists notebooks, and opens the first one when the URL names none. The root is the container notebooks live in, not a place to put notes, so the app will not create a note there — and it gets a row only in the case below.

   **Resolved (Phase 2).** A `.md` file sitting loose at the root of the remote app folder — put there by hand, or by another tool — imports to a note in no notebook, which the sidebar had no way to show. We do **not** move those files: relocating them would contradict "the user sees the same structure from any other tool" (§1) and quietly rewrite their remote layout. Instead the sidebar grows a **"Loose notes" row that appears only when the root actually contains notes**, below the notebooks, showing the count. It is not the "All notes" row removed in Phase 1: that one always showed and misdescribed what it held; this one names exactly what it holds and disappears when empty. Opening it lists those notes and leaves "New note" disabled, because the app still does not create notes at the root.

   Three consequences worth knowing about:
   - `ROOT` is `''`, and an empty search param is indistinguishable from an absent one, so the URL spells the root `/`. The translation lives in `apps/web/src/routes/search.ts` and nothing else in the app knows about the sentinel.
   - A notebook created while the loose notes are open goes beside them, at the root — the root is not a notebook and cannot be a parent.
   - The tree and the count of loose notes come from two independent live queries. Neither `undefined` may be read as "there are none", or the app opens one folder and jumps to another a frame later — with no notebooks at all it would briefly tell a user whose whole library is loose notes that they have nothing. `selectedFolderPath` takes the count, not a boolean, for exactly this reason.

## 13. Distribution and licensing

### Repo
One public repo, `skysa-notes`, containing everything in §11. It is self-hostable and complete: placeholders only in `wrangler.toml`, `.dev.vars.example` listing every key, no operator credentials or deployment-specific configuration in the tree. Defaults are `AlwaysAllowedEntitlementProvider`, `AUTH_MODE=storage-first`, and all four providers enabled. Anyone who needs different behavior composes it through `createApp` (§6) rather than forking.

### License: AGPL-3.0 + CLA (decided; confirm final CLA text with a lawyer)
- **AGPL-3.0** for all code. Anyone may use it, including commercially, but anyone offering a modified version as a network service must publish their modifications, so improvements made to deployed instances flow back. Standard posture for self-hostable web apps (Plausible, Cal.com, Ghost).
- **CLA**: Apache ICLA adapted (entity name substituted, "Project" for "Foundation"), structured as a **license grant, not an assignment**, so contributors keep ownership and it remains valid in jurisdictions that don't allow copyright assignment. Two clauses borrowed from the Harmony agreements: (1) Skysa promises every contribution will remain available under AGPL-3.0, and (2) contributors retain full rights to use their own contributions elsewhere. The grant includes the right to sublicense and relicense, which keeps future licensing options open. Individual CLA required from day one; an adapted Apache CCLA (entity CLA) is prepared but only requested the first time someone contributes on behalf of an employer. Enforced by `contributor-assistant/github-action` blocking merges from unsigned contributors.
- Rejected: PolyForm Noncommercial (not open source; would block "open source" framing) and BUSL (change-date complexity without much benefit over AGPL).

Also:
- `TRADEMARK.md`: the code license does not grant use of the `skysa-notes` / Skysa name or logo; forks must rebrand.
- Third-party license audit before publishing (Milkdown, CodeMirror, Hono, Drizzle, Workbox are all MIT/Apache — fine; re-check any additions).

### Self-hosting model
A self-hoster needs: a Cloudflare account (Workers Free is sufficient indefinitely for personal use; the daily limits are unreachable by one person), their own Google/Entra/Dropbox app registrations (named `skysa-notes` so folder names match), and ~15 minutes with `docs/self-hosting.md`. Their Google app stays in "Testing" (≤100 users, unverified-app warning) unless they pursue verification themselves. WebDAV needs no registration at all, which makes it the easiest self-host path and worth featuring in the docs.

Operators running an instance for many users should know two things, both to be documented in `docs/self-hosting.md`:
- Workers Free hard-stops at 100k requests/day until 00:00 UTC, which would break token refresh for every user of the instance at once. Workers Paid bills per request instead, lifts the CPU limit (set `limits.cpu_ms = 50` in `wrangler.toml` to cap runaway cost), extends logs to 7 days, and enables Logpush. Capacity is not the concern: Free covers roughly 5k daily actives at ~20 Worker requests/user/day, and static assets are free and unlimited on both plans. Pricing verified 2026-09.
- Back up D1 with `wrangler d1 export` on a cron trigger. The database holds encrypted refresh tokens and connection metadata, never note content.

## 14. Not planned (possible future add-ons)

None of these are in any phase. Listed so the reasoning isn't lost if they come up.

- **Apple sign-in.** One `IdentityProvider` adapter via Arctic. Specifics: JWT client secret minted from a `.p8` key (rotate ≤6 months), POST callback (`form_post`), user's name delivered only on first authorization, Hide-My-Email relay addresses require the explicit link path, no localhost testing, $99/yr Developer Program. Not required for a browser-installed PWA.
- **Facebook sign-in.** One adapter via Arctic. Email not guaranteed (phone-only accounts, declined permission), so it would need an email-confirmation step. Meta App Review with privacy policy and data-deletion URL; possible Business Verification. Likely lower demand than Apple for this audience.
- **Magic link.** An `email` identity type in `identities`, plus transactional email infrastructure (Resend/Postmark, SPF/DKIM/DMARC) and a one-time-code fallback for the PWA link-opens-in-browser problem.

## 15. GitHub setup

Organization `skysa` (fallback `skysa-notes`), created before the first commit — it is the named party in the CLA and `TRADEMARK.md`. Org-level: required 2FA, secret scanning with push protection.

| Repo | Visibility | Contents | Deploys? |
|---|---|---|---|
| `skysa/skysa-notes` | Public, AGPL-3.0 | The workspace in §11. Placeholders only in `wrangler.toml`; `.dev.vars.example` | No. CI + dry-run only |
| `skysa/cla-signatures` | Private | JSON written by the CLA action | No |
