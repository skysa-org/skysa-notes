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
| Client | Vite + React + TypeScript SPA, `vite-plugin-pwa` (Workbox) for the service worker, TanStack Router, SWR for server state, Dexie (IndexedDB) for local store | Local-first app gets nothing from SSR; vite-plugin-pwa is the best-maintained PWA tooling in the React ecosystem |
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
| Conflicts | Never lose data. On conflict, keep the remote version at the original path and write local as `<name> (conflict <ISO date>).md` | Simple, predictable, recoverable |
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

export interface ChangeEntry extends RemoteEntry { deleted?: boolean }

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
- Files: `POST content.dropboxapi.com/2/files/upload` with `mode: { ".tag": "update", update: rev }` for conflict-safe overwrite (Dropbox returns a conflict error rather than auto-renaming when `autorename: false`). `mode: add` for create.
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
- [ ] Auth start/callback, sessions, encrypted connections table, `/api/token`
- [ ] `DropboxProvider` implementing the full interface
- [ ] Sync engine: pull, push, cursor persistence, opQueue
- [ ] UI: connect one account (replace/disconnect only, no multi-account), sync status indicator, manual "sync now"

### Phase 3 — OneDrive (1 day)
- [ ] `OneDriveProvider` (approot, delta, If-Match)
- [ ] Contract tests pass

### Phase 4 — Google Drive (1–2 days)
- [ ] `GDriveProvider` (drive.file, folder creation/discovery, changes API, parent→path mapping)
- [ ] Contract tests pass
- [ ] Document the Google OAuth consent-screen verification path (non-restricted scopes) for operators who want to leave Testing mode

### Phase 5 — WebDAV (1–2 days)
- [ ] `/api/webdav/*` proxy with allowlisting
- [ ] `WebDavProvider` with sync-collection detection and PROPFIND fallback
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
      api/                    # typed client for apps/api (SWR hooks)
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
6. **Every note lives in a notebook; the root is not one.** The sidebar lists notebooks only, and opens the first one when the URL names none. The root is the container notebooks live in, not a place to put notes, so it has no row and the app will not create a note there. **Phase 2 follow-up:** a `.md` file sitting loose at the root of the remote app folder — put there by hand, or by another tool — imports to a note with no notebook, which the sidebar has no way to show. The scanner must give those a home (or the sidebar must grow a row for them) before Phase 2 ships. See §7.

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
