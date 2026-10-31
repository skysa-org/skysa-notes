# Build history

The product was built in numbered phases, and this is the record of them: what each one delivered and what was learned doing it.
Everything here is shipped unless a line says otherwise.

This is history, so it is not kept current.
Each phase says what was true when it shipped, and a later phase may have replaced it.
For how the app works now, read [`ARCHITECTURE.md`](ARCHITECTURE.md); a `§` here means a section of that file.

The phase names survive because `ARCHITECTURE.md` and comments in the code cite decisions by phase ("Phase 7", "the Phase 2 connect flow") and by the headings below.
Open work is not tracked here: it lives in GitHub issues, and every line that used to be an open checkbox now names its issue.

## Phase 0 — Scaffold
- pnpm workspace with `apps/web` (Vite + React + TS), `apps/api` (Hono + TS), `packages/core` (shared TS, no framework deps); shared ESLint/Prettier/tsconfig base
- TanStack Router with a single `/` route plus `/auth/callback` landing route
- `wrangler.toml` with D1 binding + `[assets]` for the SPA; Drizzle schema + first migration; `pnpm db:migrate` (local and remote)
- `packages/core/src/config.ts` exporting `APP_FOLDER_NAME = 'skysa-notes'`, `MARKER_FILE = '.notesapp.json'`, `MARKER_SCHEMA_VERSION = 1`; `marker.ts` with `buildMarker()` / `parseMarker()` and the read-only-on-newer-version rule
- `vite-plugin-pwa` wired, manifest generated, PWA installable (manifest, service worker, and 192/512 + maskable icons all present and served; not yet confirmed with a Lighthouse run in a real browser)
- Vite dev proxy → `wrangler dev` on `:8787`; single `pnpm dev` runs both
- Register provider apps (Google Cloud, Entra, Dropbox App Console) with the name `skysa-notes` and the callback URLs for local + prod — an operator task, done per deployment rather than in the repository.
  `ENABLED_PROVIDERS` lets an instance run with only the providers it has registered (WebDAV, which would need none, is deferred — §5.4)
- Env validation (`zod`) for all provider client ids/secrets and `SECRETS_KEY`

## Phase 1 — Local-only notes
- Dexie schema, notes/folders CRUD in IndexedDB
- Markdown parse/serialize wrappers in `core` + round-trip fidelity suite (write this before wiring the editor)
- Sidebar folder tree, note list
- Rich editor (Milkdown: commonmark + gfm presets, slash, tooltip, history, listener) via `@milkdown/react`; pin version — pinned at 7.22.1.
  `plugin-listener` is deliberately not used: see §7
- Raw editor (CodeMirror 6), mode toggle, per-note mode memory, "dirty only on real edits" rule verified by test
- Frontmatter strip/reattach, slug filename logic
- Works fully offline; installable

## Phase 2 — Backend + Dropbox end to end
Dropbox first: simplest API, proper conflict semantics, long refresh tokens.
- Contract test suite + in-memory fake provider (write this before the first adapter, as the round-trip suite was written before the editor)
- Auth start/callback, sessions, encrypted connections table, `/api/token`
- `DropboxProvider` implementing the full interface
- "Loose notes" sidebar row, resolving the §12.6 ship blocker.
  Split out of the sync-engine PR because it depends on nothing the engine adds, and the engine is large enough on its own.
- Sync engine: pull, push, cursor persistence, opQueue (`packages/core/src/sync/`).
  The `SyncStore` port is defined here and implemented over Dexie in the UI PR below, where it registers against `tests/sync/storeContract.ts`.
- UI note, carried from the PR above: `useNote` reads `db.notes.get(id)`, which returns a tombstone, so a note deleted remotely while it is open stays fully editable in the right pane after the list and sidebar have moved on.
  Harmless until the engine runs in the browser, which is the PR below.
  *Done:* `useNote` treats a tombstone as gone.
  The remote case above turned out not to exist — a pull hard-deletes a clean note and detaches a dirty one, and neither leaves a tombstone — but another tab deleting the open note does, today.
  An edit that lands on a tombstone anyway — an autosave still pending when another tab deletes the note — is written into it and the note stays deleted, the same call §7 makes ("the delete wins").
  The case still open is its own item below.
- UI: connect one account (replace/disconnect only, no multi-account), sync status indicator, manual "sync now".
  Split into four PRs: the Dexie `SyncStore` (`apps/web/src/sync/store.ts`, done), local edits queuing push ops (`apps/web/src/store/queue.ts`, done), the connect flow — itself two PRs, moving the device's rows onto a connection (`apps/web/src/store/connection.ts`, done) and the API client with the connect/disconnect UI (`apps/web/src/api/client.ts`, `apps/web/src/sync/account.ts`, `AccountPanel`, done) — and the scheduler/status/sync-now/CSP, itself three PRs: the sync runtime (`apps/web/src/sync/tokens.ts`, `apps/web/src/sync/scheduler.ts`, `apps/web/src/sync/providers.ts`, done), wiring it into the app with the status line and "Sync now" (`apps/web/src/sync/runtime.ts`, `AccountPanel`, done), and the CSP (`apps/web/public/_headers`, done; §9).
  *How the status is shown:* one scheduler for the app, started in `main.tsx` before the first render rather than by a component, so a remount never restarts it; the app version for the marker file comes from `package.json` through Vite's `define`.
  The storage panel reports the scheduler's status under the connection — when it last synced, syncing, offline, trying again, or what needs attention — with "Sync now" once the scheduler has picked the connection up (disabled while syncing), and a line when conflict copies were made.
  A refusal that connecting again would fix (`reauthorize_required`, `sign_in_required`, a fresh token refused) is said once, with the same "Connect again" link as an ended session where the server offers connecting — and said without it where it does not, or its config could not be had, since sync has stopped either way.
  Retrying shows the error.
  A provider this build has no adapter for is said to be one, not promised a retry.
  It is not a live region: it changes every minute.
  The panel asks `/api/connection` on open and again when the device is bound to a connection its answer does not name (another tab connecting) — never because of an answer alone, so a server it cannot reach is not asked in a loop, not when the binding goes away, which the panel shows from the store, and never while a question is out: a bind that lands meanwhile is weighed when the answer comes in, so an answer sent with an old session does not hide a connection another tab just made.
  *How syncing runs:* the scheduler follows the one `syncState` row through a Dexie `liveQuery`, not a caller, so a connect, a disconnect or another tab switching accounts all land the same way — the old connection's session is dropped and whatever it was doing is ignored when it answers.
  Each run, one at a time per connection — a trigger mid-run asks for one more after it, and the run holds a Web Lock named for the connection, so a session ended mid-run and another tab cannot put a second engine at the network beside it (which is why every provider request has a 60 s deadline, `sync/providers.ts`: a request left hanging would otherwise hold the lock, and every tab's sync, for as long as the browser let it): offline does nothing until `online`; then `verifyResume` (every run, since it answers at once when there is nothing to check, and a re-bind to the same id may never show as a change), `ensureRoot` once per connection (`rootId` in `syncState`), then pull and, if the pull reached the end, push (`engine.sync`, split so `lastSyncAt` records the last pull that reached the end whatever the push did).
  A run the device was bound or unbound during — a store refusing with `UnboundConnectionError` or `UnverifiedResumeError` reads to the engine as a transient failure — is not shown; it is run again.
  Triggers are §7's less Background Sync: open, focus, becoming visible, `online`, every 60 s while visible (a hidden tab waits for `visibilitychange`), and 2 s after the last local edit, seen as a new highest op `seq` for the connection (a queued write covers later edits until it runs, and the store queues a fresh one for an edit made while it was in flight, so the seq is enough; the engine's completions and failures never raise it, and the ops a conflict or an in-flight edit queue cost one more sync).
  Access tokens come from `/api/token`, kept in memory and in `syncState` (`accessToken`, `accessTokenExpiresAt`, written with `update` so a connection let go of meanwhile does not get its row back) and replaced a minute before they expire; `expiresAt` is moved onto the device's clock by the response's `Date`, since a device clock hours out would otherwise mint a token per request.
  A provider `AuthError` gets one fresh token, then `paused` — before the engine runs (`verifyResume`, `ensureRoot`) as well as inside it.
  A server refusal to mint (`reauthorize_required`, `sign_in_required`, `not_entitled`, `not_found`) is not retried on a timer and is not asked again inside the same run; the status says `attention` with the refusal, and the next trigger tries again.
  The refusal is forgotten as soon as a token is had from anywhere (another tab's, in the row) or the server fails to answer at all, so it never outlives what it describes.
  Transient failures retry after 5 s, doubling to 5 min — and while a retry waits on its timer, edits, focus and visibility leave it to that timer (only "Sync now" and `online` go first), because every failed push is an attempt against its op and a keystroke's debounce would otherwise spend them all in seconds — reset by a sync with nothing left failing that time can fix (`ok` or `blocked`); a failure that finds the browser offline reads as `offline`.
  Conflict copies accumulate in the status for the session, whichever sync made them.
  `blocked` is `attention`, but pulls go on every minute, and it is not for ever: the engine counts every failure an op has, an outage's included, so an op gets eight (about ten minutes of the backoff), and a blocked op gets its attempts back when the user presses "Sync now", on `online`, and on its own fifteen minutes after it first blocked.
  *How connecting works, as of this phase.*
  Phase 7 replaced the list-and-session design this passage describes, and §6, "Per-connection credentials", is how it works now.
  A credential reaches exactly one connection, so nothing "binds to the first one"; there are no sessions, and the device lets go only on `credential_revoked` or `not_found`; the connect button is a POST that answers a URL; and Phase 9's sign-in was dropped on 2026-09-18.
  The server is the authority on whether an account is connected, and the device follows.
  On open the panel asks `/api/connection` with the credential this device holds, which reaches exactly one connection: a credential a flow has just consented for claims that connection (`claimConnection`), and otherwise the binding the device already has is confirmed, and let go of only on `credential_revoked` or `not_found`.
  A signed-in empty list unbinds (it was disconnected from another device), but no session changes nothing: an expired session is not a disconnect, and the panel offers "Connect again", which keeps the connection's id for the same account.
  Offline, the panel shows what the device is bound to.
  Disconnect asks the user first and the server second, and the device lets the source go only once the server has (or no longer has the row); letting go first and failing to reach the server would leave a live refresh token that the next open binds to again.
  The connect button is a navigation to `/api/auth/connect/:provider/start` with `returnTo` set to the current URL, and the callback's `?connect=` outcome is shown once, then taken out of the URL.
  Only storage-first instances offer it: account-first needs the sign-in of Phase 9.
  The old `/auth/callback` route is gone, since the API owns the callback.
  Because binding follows the server's answer, that answer must be current: the service worker never serves `/api/*` from a cache (an hour-old list replayed after a disconnect would bind the device again), and nothing else may store one either: every `/api/*` answer says `Cache-Control: no-store` and the client asks with `cache: 'no-store'`, since before that no answer carried any freshness information at all — no `Cache-Control`, no `ETag`, no `Last-Modified` — which leaves an HTTP cache to guess, and the same replay would unbind a live connection or hand back a revoked access token.
  A connection row the app cannot parse fails the list rather than reading as no connections (only a provider it has no adapter for is left out), and a bind or unbind decided from an answer runs only if the device has not been bound or unbound since the question went out (a count in `prefs`, `sync.bindings`, bumped by every bind and unbind, since the connection itself can come back to where it was), checked in the bind transaction — otherwise the server is asked once more.
  Disconnect is disabled until the answer on open is in.
  When disconnect is refused for want of a session (possibly after the server let go and the answer was lost), the panel offers to stop syncing on this device alone.
  `safeReturnTo` in the API checks the path as resolved, so `/.//evil.example` cannot become a protocol-relative redirect.
  *How binding works:* the app shows and writes exactly one connection, the one `syncState` row (or `LOCAL_CONNECTION_ID` when there is none), and every store reader and writer not told a connection resolves it — each writer inside its own transaction, so a write cannot land under a connection a bind has just replaced.
  Binding moves every row onto the new connection in one transaction, cut loose from any file it had, dirty, with `source` pinned, a `mkdir` queued per notebook and a `write` per note; the old queue and cursor go, and a tombstone is dropped (its delete was owed to an account nothing is sent to now — not true when the same account is connected again, below).
  Disconnecting touches nothing remote.
  (Until 2026-09-19 it moved the rows back to `LOCAL_CONNECTION_ID` the same way; it now removes what the remote has, and what the remote was never sent is the user's to keep, move or discard, asked before anything is said to the server — §6, "Letting a source go".)
  A sync still at the network when the connection changes writes nothing: the Dexie `SyncStore` refuses every write once its connection has no `syncState` row, checked in the transaction binding locks, since a late cursor would otherwise put the old row back and make it the app's connection again, with every note under another.
  Rows under two connections that spell a notebook two ways (`Work`, `work`) move onto one spelling, the target's if it has one.
  *Reconnecting and switching accounts* (the follow-up to the connect UI, `accountId` end to end): a connection id is not an account — disconnecting deletes the server row, so the same account connected again gets a new id — so `/api/connection` returns the provider's `accountId`, and the device keeps it on the `syncState` row, which outlives a disconnect whenever anything is kept (`detached`).
  Disconnecting keeps what the remote has not been sent — each such note's `remoteId`/`remoteVersion`/`dirty`, the tombstones it is owed and the queued ops — under the source's own id, where the user has not asked for it to be moved to another source or discarded by name; binding the account of a detached source *resumes*: the rows and their queue move over unchanged and only the cursor is new, so the first pull is a full scan that sees edits, renames and deletes made on either side while disconnected, and nothing is re-uploaded or turned into a conflict copy.
  Binding any other account takes nothing from a detached source: its rows stay where they are, a source of their own, because the likeliest way to get there is picking the other of two logged-in Dropbox accounts on the consent page, and notes that belong to one account are never copied into another unasked.
  (There was a prompt for it, `other-account`; it went with the pile it asked about.)
  The device's own rows — written before anything was connected, so no account's — are *copied* into the first source bound: cut loose, dirty and owed a write as above.
  Clicking Connect was the asking.
  A row that has to change path on the way (only when rows already sit under the target) is copied even when resuming, since its file is at the old path.
  A resume trusts the first scan to say what was deleted while the device was away, and an app folder emptied or replaced in that time looks the same to a scan — every unedited note would be deleted here.
  So a resumed bind that carries remote ids is marked `resumeUnverified`, the Dexie `SyncStore` refuses every write for it, and `verifyResume` must run first: it reads up to eight of the notes' own files by id, the most recently edited of each notebook in turn, at any depth, loose notes as one (so one notebook deleted elsewhere cannot stand for the folder).
  One found and the resume stands, whatever the others said.
  None found and none failing, and the rows are copied instead (cut loose and written back).
  None found but some failing — offline partway, rate limited — and it throws and the flag stays, to be asked again: half an answer does not decide a copy.
  The one way that can hold sync up is a file that always fails while every other sample was deleted elsewhere; the scheduler shows the error.
  Notes deleted elsewhere across every sampled notebook can therefore turn a resume into a copy, which brings them back — the safe direction.
  A device bound before the API named accounts learns its account on the next reconcile.
  A source detached before its account was named is resumed only by its own connection id coming back: with no account to compare, no other bind takes its rows.
  A notebook moved or renamed locally drops its `remoteId`, since a full scan would otherwise read the id at the old path as a remote rename and undo it (the old notebook reappearing empty remains the Phase 6 gap).
  A note deleted here while disconnected, however long, still wins over edits made to it elsewhere (§7).
  The scheduler (next PR) must stop the old engine on every bind and unbind, call `verifyResume` before a connection's first push or pull (the flag stops the store recording results, not the provider calls), refresh the token if it fails with an `AuthError`, re-reconcile the account panel when another tab changes the binding, and not show `UnboundConnectionError` or `UnverifiedResumeError` retries as a sync failure.
  Two things the connect flow must guarantee, because the store refuses rather than guesses: no note row may be left under a connection other than the one being synced when its notes can reach the remote — the store refuses to pull a file over another connection's row with the same frontmatter `id`, and since the engine decides the same way on every retry, sync stops there until the rows are moved — and rows moved off `LOCAL_CONNECTION_ID` get `source` pinned as they move, so their bytes stop depending on `updatedAt` and path before the engine ever reads them.
  A deleted note's queued `write` and `move` ops are kept, not dropped: a write already at the network when the delete lands may be the one creating the file, and dropped, the store would never learn its `remoteId`, the delete would purge the row with nothing to remove, and the file would come back on the next pull.
  The connect flow must also queue a `write` for every rebound row the remote has never had — notes made before connecting have no ops, because nothing queued any until this PR — and a `mkdir` for every notebook.
- A pull that hard-deletes a clean note while an autosave is pending made that save throw `No note with id`, and the words were lost with no conflict copy.
  The same window let a pull replace the body under a pending edit, and the next keystroke's save put the old text back over it, or dropped the edit.
  Carried from the `useNote` note above.
  Fixed by saves that carry the origin of the body they were typed into (§7, "Edits the editor has not saved yet").
- Verified against Dropbox itself (2026-09-21): connect, authorize, and see notes sync both ways, with `PROVIDER_LIVE_TESTS=1` green — 356 scenarios, after the two it turned out never to have been testing were rewritten and the folder-kind bug they exposed was fixed.
  Both directions checked by hand in the app as well: a note made here appeared in the Dropbox folder, and an edit made in the Dropbox web UI was in the editor within seconds.
  Every question below was answered and the answers are recorded in §5.3.
  What was open and is now settled, with a cursor held: the two forum-sourced claims (a renamed folder's old path deleted and every child listed again at the new one; a round's entries in the order things happened) both hold; `list` on a folder saw everything `delete` then removed (the `rmdir` guard); and `files/create_folder_v2` makes the missing parents itself, so the `mkdir` retry it was feared to need is unreachable on Dropbox.

## Phase 3 — OneDrive
- `OneDriveProvider` (approot, delta, If-Match), and its hosts in the CSP's `connect-src` (§9): `graph.microsoft.com`, and the hosts an item's download URL points at, which are not Graph (`*.files.1drv.com`, `my.microsoftpersonalcontent.com`, `*.sharepoint.com`).
  `tests/csp.test.ts` reads a file through the adapter from each and checks every host it reached is allowed.
  The download hosts come from Microsoft's docs and reports, not yet from a live account; the item below proves them
- Contract tests pass — over a transport stub that speaks Graph's wire format, at one entry per page and at full pages (`tests/providers/onedriveStub.ts`)
- Verified against OneDrive itself (2026-09-21, personal account), bar the CSP check deferred to #98.
  `PROVIDER_LIVE_TESTS=1 ONEDRIVE_TEST_TOKEN=…` green at 356 scenarios, which settles the upload and move semantics §5.2 takes from outside Graph's reference pages and `delta` on `special/approot` — the first run failed eight of them to a single bug, folders created by path (§5.2, fixed).
  Connected in the app and synced both ways, including moves and edits made on each side.
  With a cursor held, scripted against the account: deleting a folder of notes, and both one-round cases (delete a folder while moving a subfolder of notes out of it; rename a folder while moving a note into it) — each as §5.2 now records, the notes staying where the remote has them.
  Crossing the app-folder boundary in the OneDrive web UI — a note moved out, a folder of notes moved in — was confirmed in the app, which is the level it was checked at: what the app did with each was right.
  The wire detail behind them (whether a note moved out arrives as a deletion, whether a folder moved in has its notes listed) was not captured, and §5.2's reading of it is still the documented one.
  **Deferred:** under the deployed CSP, reading a note from a personal *and* a work or school account with no violation in the console — #98.
  The live suite runs in Node, where no CSP applies, so nothing here covers it; the download hosts in `connect-src` are still only as good as the docs they came from.
  A work or school account may need publisher verification before it can consent at all (`.dev.vars.example`).
- API: Microsoft storage OAuth (connect, callback, `/api/token`, disconnect) behind a provider registry (`apps/api/src/oauth/providers.ts`), so the routes no longer assume Dropbox
- Web: connect OneDrive — the adapter in the scheduler's provider factory (`apps/web/src/sync/providers.ts`), OneDrive offered wherever the server enables it (`CONNECTABLE`), and the disconnect confirmation saying where to remove the app's access, since Microsoft gives an app no way to withdraw its own (`LEFT_AT_PROVIDER`, `apps/web/src/sync/account.ts`)
- Record the bytes a note last synced (`SyncNote.syncedHash`, persisted by `apps/web/src/sync/store.ts`) so a remote rename is not read as a remote edit: a note holding unpushed edits whose file is renamed remotely on a provider whose version changes on a move follows the rename and keeps its edit, with no conflict copy.
  See §7.

## Phase 4 — Google Drive
- `GDriveProvider` (drive.file, folder creation/discovery, changes API, parent→path mapping), as §5.1 describes: canonical items where names repeat, verify-after-create, duplicates renamed apart before the engine sees them, and the contents of a folder moved in listed into the page
- `www.googleapis.com` in the CSP's `connect-src` (§9), with `tests/csp.test.ts` reading and updating a note through the adapter — metadata, bytes and uploads are all asked of it, so it is the one host the adapter names; whether Google redirects a download elsewhere waits on the live check below
- Contract tests pass — over a transport stub that speaks Drive's wire format, at one entry per page and at full pages (`tests/providers/gdriveStub.ts`); what its unique paths cannot hold (two items with one name, races with another device) runs over a scripted Drive in `tests/providers/gdrive.test.ts`
- Verified against Google Drive itself (2026-09-21): `PROVIDER_LIVE_TESTS=1 GDRIVE_TEST_TOKEN=…` green at 356 scenarios — and, unlike Dropbox and OneDrive, **no adapter bug**: the six scenarios that failed first time all failed because the suite assumed a change feed that is immediate and reports a thing once, which Drive's is not and does not (§5.1).
  The harness now waits for the feed rather than assuming it (`changesLagMs`, `quietCursor`, `drainUntil`) and waits for its own deletions to leave the search index before the next scenario.
  Connected in the app, and with a cursor held, each answer recorded in §5.1: what a page token Drive will not take answers (400, named only by `location`); that trashing a folder lists what is inside it and renaming lists the folder alone; that deleting a folder while moving a subfolder of notes out of it in one round leaves the notes where the remote has them; that a name search finds a file created a moment before (0.3–0.4s, so verify-after-create and the path walks are safe); that `alt=media` is served from `www.googleapis.com` with no 3xx to `*.googleusercontent.com`; and that a first connect leaves one app folder, not two.
  **Still open (issue #120):** that files made on one device are visible from another under `drive.file` (needs a second device or browser profile on the same connection), and the OAuth round trip with **Drive unticked** on the consent screen, which should store nothing and answer `connect=partial` without revoking.
  Both need a browser.
- Document the Google OAuth consent-screen verification path (non-restricted scopes) for operators who want to leave Testing mode — `docs/google-oauth.md`
- Web: connect Google Drive — the adapter in the scheduler's provider factory (`apps/web/src/sync/providers.ts`) and Google Drive offered wherever the server enables it (`CONNECTABLE`).
  No `LEFT_AT_PROVIDER` entry: disconnecting revokes at Google
- API: Google storage OAuth (connect with offline access and fresh consent, an unticked Drive scope answered as `connect=partial`, refresh keeping the stored token, revoke on disconnect) in the provider registry (§6, "Storage OAuth, as built")

## Phase 5 — WebDAV (deferred indefinitely)
*Deferred 2026-09-17.*
Not scheduled.
The design is §5.4, and what building it would take — the proxy and its hardening, the adapter, what `remoteId` means where it *is* the path, and the servers to test against — is recorded in issue #122.
Phases 6 onward do not wait on it, and "every provider" in them means the three that exist: Google Drive, OneDrive and Dropbox.

## Phase 6 — Sync hardening
- Conflict rule implemented and tested for every provider.
  `packages/core/tests/sync/overProviders.test.ts` runs two devices — each an engine over its own store and adapter, sharing one remote — over the fake in both folder modes and each adapter over its wire stub (each at one entry per page as well): the §7 rule for an edit on both sides, an edit against a delete each way, an edit under a remote rename, two `Untitled.md`s made offline, a conflict found by the push, and a copy reaching the other device; then 120 seeded runs of random creates, edits, renames, deletes and syncs, after which both stores must equal the remote and every edit must be in some file unless a delete may have taken it.
  It found ten ways two devices stopped agreeing — two where a note deleted on one device took the other device's new file at its name and its queued delete then removed that file, the rest a note kept on one device whose file was gone, or a file taken by the wrong note — each fixed with a test in `tests/sync/engine/twoDevices.test.ts` (§7, "A path can be reused" and the bullets around it).
  **Known gap (issue #123):** a second rename of a note sends its `move` to the back of the queue (`store/queue.ts`), behind a note the user has since made at the old name.
  That note's write finds the file still there, so the push moves the new note aside to a conflict name (§7, "A push conflict over a file another note already holds") and answers `retry`; the next sync writes it there.
  Nothing is lost, but the note the user just named is renamed.
- Rename/move handling, folder rename cascading.
  A notebook renamed or deleted here goes up as its notes moving or being deleted one by one, as it did, with one `rmdir` op queued behind them for the directory they left (`store/folders.ts`, `store/queue.ts`); a `mkdir` that lands now records the folder's `remoteId` (the `made-folder` outcome, where before only a pull set it), which is what lets that `rmdir` say which folder it means, and one withdrawn before it was ever sent leaves no directory to remove.
  So on Dropbox and OneDrive the old directory no longer stays on the remote, and a notebook renamed or deleted here no longer comes back empty on the next pull (§7, "A directory the user's notebook left", "A folder is removed only where a listing can prove it empty", "A folder this device is removing", "A folder deletion with no id", "A notebook gone before its `mkdir` was sent" and "A notebook the remote no longer has").
  Making the notebook again withdraws the `rmdir`, at its path or above it.
  **On Google Drive the directory stays**, and the notebook can still come back empty after a re-scan: `drive.file` hides files the user put there themselves, so no listing can show the folder is empty and deleting it would trash what the app cannot see.
  (Since 2026-10-13 the directory is left instead — marked, and no notebook on any device while it holds nothing the app can see: §5.1, "A folder the app has left".)
  Review found five ways the first cut of this went wrong, each now tested: the Drive blindness above; a notebook made and then deleted or renamed before its `mkdir` was pushed leaked a directory nothing could ever remove, and came back as an empty notebook; this device's own id-less folder deletion, coming back on the next round, deleted a notebook the user had made again at that name and cascaded over what was in it; a notebook moved up into the notebook it was in left its directory behind; and an `rmdir` for a directory the provider kept refusing stopped the queue, so every note written afterwards waited behind a tidy-up.
  The two-device soak then found a sixth, on the pull side rather than in the op: a directory removed on one device took, on the other, the notes whose files had never been in it, because their renames into it were still queued (§7, "A notebook the remote no longer has").
  **Not done, deliberately:** a single "move the folder" op.
  Note ops queued ahead of it would run against a folder that has not moved yet, and reordering the queue is the riskiest change on offer here — so a rename is still N requests for N notes, and other devices see N moves rather than one rename.
- Retry/backoff, poison-op surfacing, "reset connection" (re-scan from scratch).
  Backoff and blocking were already there; what was missing was the provider's own answer, a way to see which op is stuck, and a way out.
  All three adapters now raise `RateLimitError` with the `retryAfterMs` the provider gave (§4) — 429 and Graph's 509, and never a 503, which is an outage the op has to be allowed to reach `blocked` over — the engine retries without counting it against the op, and the scheduler waits the longer of that and its backoff, capped at fifteen minutes.
  A `blocked` sync reads the first op out of attempts and the panel names it — "Dropbox would not take the rename of Work/Plan.md after 5 tries…" — with a link to the note where there still is one.
  "Re-scan from scratch" drops the cursor, resets every op's attempts and runs, behind a confirm that says notes gone from the provider are removed here too unless they hold unsent edits.
  It drops the cursor inside the lock a run holds, not beside it: a run already at the network writes its own cursor back when its round lands, and clearing outside the lock would put that cursor back after ours went — the re-scan silently never happening, since the run that overwrote it reports success (§7, "A rate limit is not an attempt", "The provider's own answer", "A stuck op is named" and "Reading everything again is offered").
  **Not settled without credentials (issue #121):** the real `Retry-After` formats and Drive's 403 reason strings — an unreadable value falls back to the ordinary backoff, and an unrecognised refusal stays the transient error it is today.
- Apply a round of remote changes as Graph asks — the whole round decided and applied as one batch (§7, "A round is one batch").
  `packages/core/tests/sync/randomRemote.test.ts` changes a remote at random underneath one device — files written, edited, moved and deleted, folders made, renamed, nested and deleted, a few at a time — and requires the store to equal the remote after every pull, over the Dropbox, OneDrive and Drive wire stubs, the fake in both folder modes, and the fake told as Dropbox tells it (§5.3), at one to three entries per page.
  After every pull each note must be bound to the file at its path, and the store must have forgiven nothing.
  CI runs 100 seeds, and 2000 pass.
  It found, besides the page-by-page cascade: both same-page orderings (a folder swapped with its own child, and a note displaced by a folder renamed onto it); a folder renamed twice in a round losing the first rename; a new folder merged into one the round moves away; a subfolder moved up to its deleted parent's name; id-less deletions under a renamed folder dropped (§7, "A rename need not re-list"); a second id-less deletion of one path dropped; deletions of something the round had already carried to that path dropped; a Drive page listing a file ahead of the rename of its folder; the in-memory test store forgetting a folder's id on an `ensure-folder` without one (the Dexie store keeps it); and the Drive wire stub hiding an edit to a file whose folder was renamed between two looks.
  Review found four more, each now tested: a folder renamed away and back with both old names deleted by path lost its notes; a doomed folder deleted to make room for a new one at its name took a subfolder the round moves out; an id-less deletion under a renamed folder was taken when the provider could not list the folder above it, or listed it without the folder, which may only have moved on since; and two deleted folders each receiving the other's subfolder lost one of them.
  The feed told as Dropbox tells it then found two in the fix: the folder above a deleted path was taken outermost first, so its place was looked for under a folder the round had renamed, and a folder the round carried to the deleted path counted its earlier entry, where it had been, as somewhere it lived on.
  Each has a test in the engine's tests (`tests/sync/engine/`), `idTree.test.ts`, the store contract or `gdrive.test.ts`.
- A rescan that uploads rather than deletes what the remote did not return, when the provider says the remote may have lost it (OneDrive's `resyncChangesUploadDifferences`, §5.2).
  `CursorResetError` carries `uploadDifferences`, the adapter sets it for that code alone (§5.2), and `reconcile` then says `reupload-note` where it would have said `delete-note` and `reupload-folder` where it would have cascaded a `delete-folder`.
  Each forgets what the remote gave the row — a note its `remoteId`, `remoteVersion` and `syncedHash`, a folder its `remoteId` — and queues the `write` or `mkdir` that puts it back, so the next push creates the file afresh rather than writing to one that is not there.
  A *dirty* note needs none of this: `detach-note` already keeps it and its write already exists, and a note the user deleted needs the opposite — the store declines the reupload and leaves the tombstone its `remoteId`, or the delete behind it would have nothing to remove.
  No folder cascades, so every notebook is named and not the outermost only, and the `mkdir`s go ahead of the writes.
  Nothing is inferred deleted from a scan's silence, though a file the scan listed and the engine then could not read is still forgotten.
  **Not settled without credentials (issue #121):** the exact shape of Graph's 410 body, which is why the code is read from `innerError`, `innererror` and `details` alike and an unrecognised 410 takes today's path.
- Multi-device soak test: two browsers, edit same note offline, reconnect.
  `apps/web/tests/soak.test.ts` runs two complete instances of the app — two Dexie databases, two schedulers, an install id each, one remote — and makes every edit through the writer the UI calls, over the fake and the OneDrive and Drive stubs.
  "Offline" is `SchedulerEnvironment.isOnline` and the `online` event.
  Scripted: the item's own case (both edit one note offline, reconnect, and the remote keeps the path while the other edit lands beside it under a conflict name, on both instances, with the banner naming it); a notebook renamed and deleted; an edit meeting a delete; a rename made on the provider itself, which is the only way to reach the `syncedHash` rule from here; and both instances making a note of the same name at once.
  Then seeded runs of random work per remote — 40 in CI, and `SOAK_SEEDS` widens the search (600 has been run) — which must end with both instances equal to the remote, nothing dirty, no op stuck, no tombstone left, no notebook without a directory behind it, and every edit's token still somewhere — bar the ones a delete is allowed to take (§7).
  The *scripts* replay: the steps pick from notes and notebooks in path order, because Dexie answers by primary key and a UUID-keyed order chose different notes on every run, which made a failing seed unreproducible — the run that found the bug below could not be replayed from its own printed trace until this.
  The two instances are also let back onto the network *together* rather than one after the other: reconnected in turn, each run finishes alone, the two schedulers never meet, and the runs can only say that the stores end up equal — they lose every bug that lives in an interleaving, which is what they are for.
  But the *timing* is not pinned, and a seed is not a guarantee: two schedulers going at once are ordered by the event loop, and a conflict copy's name carries the clock.
  So a seeded failure is a lead, and the regression test it earns is written where the order can be set — at the engine, as `queue.test.ts` does for the one below.
  **What it found** (seed 39, on every remote): `queueDelete` left a note's queued `write` in place, so a note made and deleted before either op was sent still had its write run — creating the file and removing it again.
  Alone that is waste; where another device had made a note of the same name meanwhile, that file is what the other device's write bound its note to instead of making one, and the delete behind it took a note nobody deleted, from every device.
  A tombstone owes the remote its delete and nothing else — the rule `queueWrite` already applied from the other end — so the delete now withdraws the writes, and `resolveConflict` tolerates an op withdrawn while it was at the network, as `completeOp` and `failOp` already did (a contract test now asks both stores for that, and the in-flight write that earns the tombstone its `remoteId` has one of its own).
  A queued **move** is kept: the file is still at the name it had.

**What a wider search found.**
Running 600 seeds rather than 40 turned up four things.
One is the app's: `createFolder` refused a notebook whose name only a *deleted* note still spelled, because the check counted every note row while `listNotes` — and so the sidebar — leaves tombstones out.
Removing a notebook and making one of the same name again, which this section says withdraws the `rmdir`, was answered "already exists" with nothing shown there, and offline that lasts as long as the device is away (seed 443).
Two were the script's own fault.
It excused a token a delete is allowed to take only when the deleted row carried a `remoteId`, so a note deleted *before* its create had ever been pushed excused nothing — while the other browser, which had pulled the same note and did have a file for it, went on writing edits into it that a delete may take; the script now also remembers the note's id, but **only for that case**, because §7's `detach-note` gives an id a second life and excusing by id after that would excuse every later edit of a note §7 promises to keep.
And it asked for a notebook it had just checked was free while the scheduler pulled one of that name in between, which the store is right to refuse — the script now takes the refusal, and checks the name really was taken, so a store that refused *every* notebook would still be caught.
The fourth was recorded here as **seeds 318 and 578 failing every time, and 253, 302, 461 and 597 sometimes**, all differing in a conflict copy's `updated:` line alone.
That understated it, and a review on 2026-09-18 found what it was.
Seed 578 left one browser clean and holding a note's body *without* an edit the remote and the other browser had; seed 461, intermittently and only over the OneDrive and Drive stubs, **lost edits outright** — four tokens in no file anywhere.
Both were one fault: a move's returned version adopted over bytes nobody had read (above, "The version a move hands back").
With that fixed, all six seeds pass, over the fake and both stubs.
They turned on timing — 578 passed over the fake on CI while failing on a laptop — which is why they are held by the scripted tests in `packages/core/tests/sync/overProviders.test.ts` rather than by pinning a seed: a pinned seed that fails only sometimes is a suite that goes red by itself.

The traces also carry where a rename or move went, and not only where it started: a rename onto a path the other browser is also using is how two notes come to share a name, and a trace that stops at the old path cannot show it.

## Phase 7 — Polish
- Search (local full-text over IndexedDB; MiniSearch).
  The field is at the right-hand end of the source bar, and it searches every source on the device and every notebook in them, not the ones showing; the answers drop from the field (they took the middle pane until 2026-09-23 — §7) and say where each match is: the source, when there is more than one, the notebook, and a line of the body with the matched words marked.
  The way to another account sits with the tabs, right after the last one, and the search takes the rest of the bar (2026-09-22).
  `store/search.ts` holds the index and never touches the database — it is handed rows and told to agree with them, which is what lets `useNoteSearch` decide when, and keeps the matching and the excerpting testable as the pure things they are (§7, "Search is a question, not a place").
  Opening a match takes the user to the source and the notebook it is in — the source first, since the URL names the notebook and the note inside whichever source is showing — so the tabs, the sidebar, the list and the open note never disagree; Escape empties the field, and choosing an answer does too.
- Rich-editor polish: find/replace, outline panel.
  (Find and replace is one bar over both editors, and one engine under them: `@codemirror/search`'s `SearchQuery` decides what matches in *both*, because a shared bar whose two halves disagree about the count is worse than two separate bars.
  The package is used for that and nothing else — its own highlighter draws only while its panel is open (`if (!panel || !query.spec.valid)`), and its panel is the thing being replaced — so the decorations are ours on both sides.
  The rich half maps text offsets to document positions with a one-character stand-in for every inline leaf, since an image takes a position and no text.
  Stepping between matches never takes focus: an editor that took it would swallow the next keystroke, turning Enter-for-next into Enter-typed-into-the-note.
  Scrolling in rich mode is done by asking the match's element, not `tr.scrollIntoView()`, which walks up from the DOM selection — in the bar — and scrolls the bar.
  A replace is a user edit and marks the note dirty; finding and moving are not.
  Verified in Chrome in both modes, including the bar keeping its query across a mode switch.)
  (The outline panel is done: `headings` in core reads the note's markdown with the same parse the editor does, so a `#` in a fenced code block is not a section, and it reports a **line** rather than an offset because `parse` folds CRLF and offsets move with it.
  The rail lives inside `.note-view`, not as a fourth child of `.app-shell`'s grid.
  A click is sent by the class the open editor puts on its own root — not by trying `findFromDOM` first, which is the same thing today only because no Milkdown code-block component is installed, and would otherwise hand back the CodeMirror *inside* a fenced block.
  Raw goes through `findFromDOM` and `doc.line`, since a heading below the viewport has no element yet; rich goes to the *n*th top-level heading child, both walks being top-level-only and that being the whole agreement between them — and a heading carries its `ordinal` among **all** top-level headings, because an empty `##` has no row in the rail but is still an `<h2>` in the document.
  `note.outline` in the registry makes it a palette command.)
  (Image paste waited in §14 for attachments, which were in no phase; both were built in 2026-10, #187, §7 "Adding a file".)
  (The `<br />` Milkdown writes for an empty paragraph is done: one rule, `previewLines` in core, now decides what a readable line is, and the note list's preview and the search excerpt are both cut from it — §7.)
- Keyboard shortcuts, command palette.
  One registry behind both (§7, "Commands are declared, not collected"): `Mod+K` opens the palette, a bare `n` makes a note, `Mod+Shift+F` puts the cursor in the search field, and `Mod+E` — which `NoteView` used to listen for itself — is now a registration like any other, so it appears in the palette with its chord printed from the same value the listener matches.
- Several connected sources on one device, each its own silo.
  Not the relaxation this line used to describe ("multiple connections per user"): there is no user to hold them.
  The device generates a credential per connection, keeps it, and sends the server only its hash; `storage_connections` is keyed on `(provider, account_id)` and `grants` on that hash; `sessions`, `holdsAnotherProvider`, `session_mismatch` and the `conflict`/`signin`/`occupied` outcomes are gone.
  §6, "Per-connection credentials", records what was decided and what was deliberately not done — including the XSS trade that `script-src 'self'` now has to carry.
- **The sources are tabs across the top, named for what they are (2026-09-21).**
  A device can hold several accounts at once and the only way between them was a list at the foot of the storage panel, which answered "switch me" but never "which of these am I looking at" — and the panes below mean something different for each, since every source is its own notes, notebooks, queue and cursor (§6).
  `SourceTabs` sits in the frame above `app-shell`, for the reason the grid's three children give, and carries everything `connectedSources` knows: the live sources, the detached ones — which hold work their remote was never sent and are editable, so a bar without them would be a bar that hides notes — and the device's own pile when it holds anything.
  The bar shows from the first source rather than the second, so the `+` is where it was last time instead of appearing only once the user has somehow reached two.

  **Names are short, derived, and the user's to overrule.**
  "Dropbox", and "Dropbox 2" for the next one of the same provider, numbered per provider in `boundAt` order with no 1 on the first; `renameSource` writes a `label` on the `syncState` row and that beats everything.
  This is a better answer to what the disconnect work left open below — the source list naming live sources by account id because `displayName` is only written while a source is in front — by not needing the server's name at all: `displayName` is still the server's, still overwritten on every reconcile, and a rename would have been thrown away by the next one.
  Derived rather than written down at connect time so that every source already on a device gets a name with no backfill, and so that letting the first Dropbox go leaves the other called "Dropbox" rather than a "Dropbox 2" with no 1 above it.
  The cost is a name moving under the user when another source goes, and renaming is the answer to it.
  Numbering counts renamed sources too, or typing a name would renumber the rest.

  A press on the tab already showing turns it into its own name, which is what makes the name part of the tab rather than a setting filed elsewhere — and is reachable from the keyboard for free, since Enter on a focused tab is that press.
  Enter takes it, Escape abandons it, blur takes it, and the field is focused *and* selected (`select()` alone focuses in a browser and not in jsdom, which is how a field that swallows the first keystroke ships).
  The pile has no row to write a name onto and so is not renamable, rather than accepting one and losing it on the next render.
  Clearing a name puts the derived one back.

  `nav` and `aria-current`, not `role="tablist"`: the ARIA tab pattern owes arrow keys, a roving `tabindex` and an `aria-controls` pointing at a panel, and the panel here is the whole application.
  "Disconnected" is in the words of the tab and not only in its colour.
  The `+` opens the providers this deployment offers, read through `useInstanceConfig`, which is one `/api/config` per client shared between the bar and the storage panel — `/api/*` is `NetworkOnly` and must stay so, so nothing below de-duplicates it.
  **Left:** the storage panel still names sources its own way, with the account id, which is the fuller answer where two accounts at one provider are in question; the two lists say different things about the same sources and one of them should give.
  **The storage panel gave connection management up entirely (2026-09-21).**
  The source list and every "Connect another {provider} account" are gone from the sidebar, and with them `Sources` and `sourceLabel`; the panel now holds only what is true of the source in front — how syncing is going, the devices holding its credential, and Disconnect — with Reconnect kept on a detached source, since that is how unsent work gets home rather than a way to add an account.
  That closes the **Left:** above by deletion: there is one list of sources now, and it is the bar.
  The panel with nothing connected says so in a sentence and points at the `+`, which means the bar shows before there is anything to switch between — it is the only place a connection is made.
  The panel's focus landing after a discard lost its last button with the list, so the frame takes `tabIndex={-1}` and is where the focus goes: not the bar's `+`, which belongs to another component and is how two of them come to fight over it.
  And the notebooks now scroll inside the sidebar rather than the sidebar scrolling as one, so the panel sits at the foot of the pane instead of at the end of the content, where twenty notebooks used to push it below the fold.
  At phone width, where the pane is capped at 14rem and there is nothing to divide, it goes back to scrolling as one.

  **The panel at the sidebar's foot is one line and a gear (2026-10-05).**
  It had grown to the source's name and account, a sentence on how syncing was going, Sync now and Re-scan, two import buttons, a download, the devices, Stop syncing and Disconnect, stacked under the notebooks and taking a third of a short window from them.
  In a wide window it is now a few words on syncing ("Synced 12:04", "Offline", "Not syncing"; until 2026-10-14 after the source's name, §7's "The line names no source"), with the source, the account and the whole of a longer status in the line's tooltip, then the gear (`GearMenu`), whose menu holds everything that was a button — the same items, in the same order, as the source's `⋯` in a compact window, so the two layouts offer one list — and "About Google Drive" where the provider keeps files from the app (§5.1).
  What needs the user's attention is still said above the line in full, where it stays until it is put right: a sentence in a tooltip is a sentence nobody reads when something has stopped.
  The devices keep their count in the line, beside the gear (§6).
  With nothing connected the line says "On this device only", and the gear holds the imports and the download; the way to connect is the `+` above, named "Connect storage provider", and the sentence that pointed at it went with the room for it.
  In a compact window's source dropdown the panel ends in the same line, with the devices' count at its end, and — since 2026-10-07, when the owner asked for it there as on a wide screen — the gear too.
  Its actions had been only in the source's `⋯` since 2026-10-01, "About Google Drive" among them (2026-10-06); the `⋯` keeps them, as every source's row has one, and the gear holds the same list but the row's own Rename.
  With nothing connected the dropdown ends in "On this device only" and the gear as well, under "Use + above to connect storage." where the `+` has something to offer: before there is a note the device's notes have no row, and so no `⋯`, and the gear is where the imports and the scratchpad are then.
  Two menus of one list share no button: each is where its own menu is anchored, and the focus goes back, after a question, to the one it was asked from.
  It had said how syncing was going in a sentence under "Syncing with Google Drive · *account*", with the devices and the Drive notice as fold-outs beneath; asked for the same as the sidebar, so a phone and a wide window say it alike.

  **Two things the tabs got wrong, found by moving the tests onto them.**
  A source whose row no longer names a provider — one brought back by a late save (`ensureDetached`) — was named "This device", the same as the device's own pile, so a device holding both showed two tabs of one name; the pile is now told by its connection id and the other is "A source".
  And a tab's accessible name was left to be assembled from its two spans, which the name-from-contents rules do not join the way `textContent` does: the name is said outright with `aria-label`, in exactly the visible words.

- **Notebooks and notes are re-arranged by dragging them (2026-09-21).**
  A notebook can be dragged into another or out to the top level, and a note can be dragged from the list into any notebook — the first UI for `moveFolder` and `moveNote`, which have been in the store, tested, and uncalled since the folder work.
  §7, "Re-arranging is moving", records what dragging was taken to mean and why hand ordering within a level is not it: there is no stored order anywhere and nowhere on a provider to put one, so a drag re-parents rather than re-sorts.
  The rules are a module with no DOM in it (`store/rearrange.ts`) because every refusal in them is a drop the pointer can really make.
  Picking up is also a command, so the whole thing works from the keyboard and from a single pointer that never drags (WCAG 2.2 SC 2.5.7) with one implementation rather than two, and the destinations say in words where the thing would land.
  **Left (issue #125):** a notebook row's accessible name is its label and its note count run together ("Work1"), which is the same name-from-contents trap the tabs hit and is pre-existing — during a move the row says its name outright, so it shows only when nothing is being moved.

- **Notebooks can be managed, and a new one goes to the top level (2026-09-21).**
  The header's `+` put the new notebook inside whichever was open, and something is open whenever there is anything to open — so after the first notebook there was no way to make a top-level one at all.
  It is now unconditionally the top level, which is what a `+` in a pane header called "Notebooks" means; inside is the rarer thing and has two ways of its own to be asked for (the menu, and dragging it there afterwards).
  Beside it, `NotebookMenu` holds what can be done to the **open** notebook: a notebook inside it, Rename, Move, Delete.
  In the header and not on every row, because the rows are drag sources and a button inside a button is not a thing HTML has — each row would become a wrapper holding two controls, for chrome on every line to serve an action taken rarely.
  That held until 2026-10-01, when each row got a `⋯` of its own beside its button (§8, "Inside the window"): a menu in the header did not say which notebook it was about until it was opened.
  `renameFolder` and `deleteFolder` were in the same state `moveFolder` was: written, tested, and with no caller, so the only way to change a notebook was to edit the folder on the provider.
  `renameFolder` now hands back the path it moved to, because the caller cannot work it out — the name is sanitised on the way in — and the open notebook is named by path in the URL, which both it and a delete have just changed.

  A rename happens in the row, the same shape the source tabs use: only the name becomes a field, and the row keeps its box, its highlight and its count, so nothing moves as it becomes editable; Enter takes it, Escape abandons it, blur takes it, and a name that did not change asks for nothing rather than queueing a move on the provider.
  A delete is **asked** rather than reported — the rule the disconnect confirm exists for (§10) — and the question carries the count of every note beneath it, including those in notebooks inside it, because that is the part the user cannot see from the tree.
  A note has no confirm because it has the notice that follows it; a notebook takes every note under it, and there is no undo built for that.
  Cancel holds the focus, as everywhere else the app asks something it cannot take back.

  `role="group"` and plain buttons rather than `role="menu"` and `menuitem`, the same choice the tabs made about `tablist`.
  The menu's items are props rather than a `children(close)` render prop: handing the close out means handing out a function that touches a ref to be called while the items are still rendering, which React's own lint rightly refuses.
  **Left:** the menu is named for the notebook it is about ("Options for “Work”"), which is the right thing to say and does collide with any test looking for a row by a loose `/Work/`.

- **A re-parented notebook no longer leaves a copy of itself behind (2026-09-22).**
  Reported against Dropbox and not Dropbox's: the same duplicate appeared over the fake, the OneDrive stub and Drive.
  Moving or deleting a notebook queued one `rmdir`, for the outermost directory, and every directory below it was left with nothing naming it — so the pull that runs before the next push adopted them as notebooks, and the `rmdir` was then refused because the device held a row under the path again.
  §7, "Folder renames/moves", records the rule and why the op is about the pull as much as the removal.
  The soak now runs over **Dropbox** as well, which it never did — the provider this was reported on was the one provider the whole-app suite did not cover.

- **The editor fills its pane, with a formatting toolbar across the top (2026-09-22).**
  Two complaints in one place.
  The editable surface was only as tall as the words in it, so most of the pane looked like the note and was not: a click below the last paragraph landed on nothing.
  Milkdown puts a `.milkdown` container of its own between the root it is handed and ProseMirror's element; left auto-height, the surface's `min-height: 100%` resolved against no height at all.
  Every element in that chain now grows, including the one the app did not write, and the fix is pinned by a stylesheet assertion (`tests/editorFill.test.ts`) — jsdom has no layout, so nothing can measure the box, but the shape of the chain is what broke and is what is checked.

  **The toolbar is grouped the way Atlassian's editor is grouped**, because that arrangement is already in most people's hands: text style, then the inline marks, then lists, then indentation, then the link.
  What is absent is absent for one reason — markdown cannot hold it.
  There is no text colour, no highlight and no alignment in a `.md` file, and a button that wrote one would put something in the note that the next save loses.
  The insert menu is not duplicated either: `/` is where a table, a code block, a quote or a divider comes from here, and the sync block has no meaning in an app with no server-side document.
  Headings reach six in the style menu, two deeper than the slash menu offers, because that is the menu where picking one by level is the point.

  Indentation is list nesting and nothing else — an indented paragraph in markdown is a code block — and the two buttons are grey wherever nesting would not happen, which includes the first item of a list, where `sinkListItem` refuses.
  The question is put to the command itself rather than guessed at from the selection.
  A lit mark button means the same thing `toggleMark` means: the mark is somewhere in the selection, so the next press takes it off.

  **One tab stop for the whole bar.**
  Fourteen buttons between the note's title and its text would otherwise be fourteen presses of Tab in the way of anybody trying to reach the note; the arrows move within it, and which control holds the stop is read from the DOM so that the order on screen and the order the arrows follow cannot drift apart.
  The panels hold ordinary buttons and a text field, not `role="menu"` — the same choice the source tabs and the notebook menu made, for the same reason: claiming a menu owes arrow-key semantics this does not have.
  (Their buttons said `aria-haspopup="true"`, which is a menu, until 2026-10-03; they are disclosures now, below.)

  **Pressed from the keyboard, too (2026-10-03).**
  The arrows moved along a bar none of whose controls could be pressed (found in the #202 review).
  Every control acted on mousedown alone, its default prevented so that focus never leaves the editor and the selection a command is for is still there, and Enter and Space reach a button only as a `click`.
  - Each control now takes a press from anything (`editor/shared/press.ts`).
    A mouse's still acts on mousedown, and the click that ends it is passed over.
    Any other click is acted on: Enter, Space, or a screen reader's press.
    Only the main button presses; the other, or Control with the main one, is a context menu.
  - Not `detail === 0` for "not a mouse".
    Some browsers send a screen reader's press as a mousedown and then a click of detail 0, which would act twice: bold on and straight off again.
  - **Focus stays where the press was.**
    A mouse never took focus from the editor, and the editor is handed it back after the command (`run` in `RichEditor.tsx`).
    Any other press leaves focus on the control, as a toolbar does.
    Handed to the editor, the next key would be typed over the selection: Space after Enter on Bold replaced the word, and Enter held down split the paragraph (found in the #203 review).
  - A row of a panel pressed from the keyboard closes the panel and hands focus to the panel's button, where it was before the panel opened.
  - A control that is off says so with `aria-disabled` and stays focusable, rather than `disabled`.
    Indent pressed from the keyboard, with nothing more to indent, was disabled under focus, and the bar's only tab stop with it; Tab then passed the bar by (found in the #203 review).
  - The panels are disclosures: `aria-expanded` and `aria-controls` on the button, and the panel a labelled `group`.
    A panel opened from the keyboard has what is in it next in the tab order.
    It closes when focus leaves it for something else on the page, as it does on a press elsewhere, but not when focus goes to another window, or comes back from one to the editor beside an open panel.
  - The floating selection toolbar takes presses the same way.
  - The arrows are the bar's only on the bar's own controls.
    In an open panel they are the panel's: an arrow in the link field used to send focus off along the bar instead of moving the caret in the address.

  The bar is only in rich mode, which is the only mode with a document model to act on; raw mode is markdown, where the characters are the formatting.
  It reads one value — `format.ts`'s reading of the selection — pushed to it by a plugin built with the editor, through a store, so a keystroke that changes which buttons are lit redraws the buttons and not the component the editor is mounted in.

  **The menus opened where nobody could see them.**
  A toolbar that scrolls sideways is a scroll box, and a scroll box in one axis is a scroll box in both — `overflow-x: auto` makes the used value of `overflow-y` `auto` as well — so every panel hanging from a button belonged to the bar's own scrollable overflow instead of hovering over the note.
  The bar wrapped instead, at first — two rows on a narrow screen being a smaller price than a menu that does not appear — and now keeps to one line by moving what does not fit into a `More tools` menu at its end (§ "Inside the window", above), which is a menu hanging from the bar like the others and so opens over the note.
  The stylesheet assertion that pins the editor's height chain still holds the bar to no scroll box.

  **Changing a list's kind is changing the node, not wrapping it** (`editor/rich/lists.ts`).
  `wrapInBulletListCommand` and its ordered twin are `wrapIn`: right for a paragraph, wrong inside a list, where they either fail or nest a second list inside the item — so switching between bulleted, numbered and task lists did nothing in most of the cases anyone would try it.
  One command now stands behind all three buttons: out of a list, into one, with an item for each paragraph selected (`wrapInList`; 2026-10-09 — `wrapIn` put one item around them all, so three lines selected and made a list were one bullet); in a list of another kind, `setNodeMarkup` on the list and on each of its items; in a list of this kind, lift out, which is what a pressed-in button promises.
  A task list is a bullet list whose items carry a checkbox — in the schema and in the markdown alike — so bullet and task differ only in the items, and that is where the conversion happens.

  **A list item that has just appeared beside task items is a task item, and an unticked one** (`editor/rich/tasks.ts`).
  Neither half is what ProseMirror does.
  Splitting an item copies its attributes, so Enter at the end of a *done* task handed back a second task already ticked; and the branch that runs when the item is empty — the second Enter, the one that lifts a nested item out — builds it with `createAndFill()`, taking the schema's defaults, which have no checkbox at all.
  Two levels deep in a checklist, a double Enter left a plain bullet behind.
  The rule is an appended transaction, and it is narrow on purpose: only on an item that has just appeared (the list it is in has more children than it had), never on a tick, and never on a body arriving from sync — emptying a finished task by deleting its words must leave the tick alone, and a pull is the file's text rather than an edit.

  **The checkbox can be pressed** — it used to be a `::before` character in the stylesheet, and nothing can press one of those.
  It is a widget decoration rather than a node view: the document is untouched by it, the tick lives in the item's `checked` attribute where the markdown is written from, and a node view would have to re-implement the schema's rendering for every list item in the note to add a box to a few of them.
  `Mod+Enter` does the same thing from the keyboard, because a checkbox inside a contenteditable surface is not somewhere the keyboard can go — Tab belongs to the editor and means "nest this item".

  **A checklist with items under items states a relationship**, and two things follow.
  Ticking a parent ticks everything under it: saying "Pack" is done says each thing packing consists of is done, which is the one direction where what the user meant is not in doubt.
  And nothing above an unfinished item is finished: unticking one child unticks its parent, and its parent, as far up as that goes.
  The other two directions are deliberately absent, each for the same reason — it would be a guess rather than something that follows.
  Unticking a parent leaves its children alone: it says the parent is not done, which says nothing whatever about work already finished, and wiping out a list of completed steps on an inference is not something the user can get back.
  Ticking the last of a parent's children does *not* tick the parent, because a parent is a task in its own right and may have a step nobody wrote down.
  The first rule is a constraint the list cannot be allowed to break; the second would be a guess about what the user meant.
  **Adding to what something consists of is saying there is more to do**, so a new sub-item unticks the item above it as well — the same constraint reached by the other route, whether the sub-item is typed at the end of its siblings or nested under its parent with Tab.
  That one is measured against the document as it *was*: only a parent this edit left standing over unfinished work is touched, because a note written somewhere else may well arrive with a finished parent over an unfinished child, and tidying that up would be the app rewriting a file it was only asked to show.
  The strikethrough moved to the item's own paragraphs at the same time: `text-decoration` reaches every descendant and no child can take it back, so striking the whole item struck a nested task that is not done.

- **Code blocks know what language they are in, and show it (2026-09-22).**
  A fence carried a language in the file and nowhere on screen: rich mode drew a bare `<pre>`, the info string was invisible, and setting one meant switching to raw mode and typing it.
  Every code block now has a bar of tools under it — language, wrapping, line numbers, copy, delete (`editor/features/code/codeBlock.ts`) — and both editors colour what is inside.

  **The grammars are CodeMirror's, and the list is curated.**
  Thirty languages in `editor/features/code/languages.ts`, not the hundred and sixty `@codemirror/language-data` knows, and the reason is the service worker: every language is a lazily imported chunk, every chunk is precached, so the list *is* what the app downloads in order to highlight a note opened offline.
  Thirty is about 550 KiB across twenty-six chunks with nothing added to the first load; a hundred and sixty would be several megabytes fetched on install for languages nobody here will open.
  CodeMirror's because CodeMirror is already here for raw mode — one set of grammars serves both editors — and because half the list (Shell, Ruby, TOML, PowerShell) has no Lezer grammar at all and arrives as a CodeMirror 5 stream mode, which `highlightTree` reads the same way.
  An info string this app does not know is not an error: `mermaid` keeps its word in the file, keeps a place in the picker, and goes uncoloured.

  **One highlighter, two editors** (`editor/features/code/highlight.ts`).
  ProseMirror gets the tokens as inline decorations over the real text and CodeMirror gets the same `tagHighlighter` through `syntaxHighlighting`, so `styles/base.css` has one palette of eleven colours to paint and neither editor has a colour of its own to disagree with.
  Classes rather than inline styles, which is also what `style-src` would rather (§9).
  What the palette deliberately names is short; what it deliberately does not name is any tag `@codemirror/lang-markdown` emits, because the same highlighter runs over raw mode where the document *is* markdown.
  `tags.meta` was in it until the test written for exactly that caught it colouring the brackets of every link in raw mode.

  **Not a nested CodeMirror inside the block**, which is how Milkdown's own code-block component does it.
  That would put the note's code outside the document the rest of the app reasons about: find and replace walks the ProseMirror doc, the dirty rule reads ProseMirror transactions, and undo is one history.
  Colour is worth none of those.
  (`@milkdown/kit/component/code-block` would also have pulled Vue into a React app, which is its own reason.)

  **Colouring is not editing.**
  A grammar arrives long after the document that wanted it, so the plugin asks for a redraw with a transaction that changes no text — which is exactly why it cannot mark the note dirty, a user edit being a document change first of all (§7).
  Tokens are cached against the ProseMirror node itself: a node is immutable, so the same object is the same text in the same language and a typed character makes a new one, which is a cache key with no invalidation to get wrong.
  A block over 20,000 characters keeps its words and loses its colours, because a pasted file is a code block too and the grammar runs on the keystroke that changes it.

  **The picker writes the info string, and that is an edit**, because it changes the user's file.
  A fence saying `js` shows as JavaScript without being rewritten to `javascript` — the picker shows the language the word names while the file keeps the word its author wrote.
  A `<select>`, deliberately: thirty names want type-ahead, arrow keys and a scroll that knows where the screen ends, and the platform's control has all three where a custom combobox would be another menu to make accessible.

  **The tools are under the block being edited, not across the top of every one** (`editor/features/code/codeTools.ts`).
  A code block is mostly read, and a permanent row of controls on each one is a permanent row of controls in the way of each one — so the bar is shown by a class on the block holding the selection, hangs beneath it over whatever follows, and is gone when the cursor leaves.
  From the selection rather than from focus, because the language menu takes focus out of the editor while it is open and a bar that vanished as it was being used would be a bar nobody could use.
  Two plugins rather than one: which block is active is recomputed on every cursor move and is a single decoration; the line numbers are a decoration per line of every numbered block and are rebuilt only when the document or the setting changes.

  **Wrapping and line numbers are the reader's, not the note's** (`store/codeDisplay.ts`, `store/prefs.ts`).
  There is nowhere in a fence to write "wrap this one" — a fence holds a language and nothing else — so these are not per-block state that would have to live somewhere outside the file and be reconciled with it.
  They are one answer each for the whole app, kept in the prefs table beside the default editor mode, and read back through a live query so a second tab follows along.
  The buttons sit on a block because that is where the reader is when they want them, not because the block owns the answer.
  The numbers are widget decorations taken out of the flow, so a wrapped line's second row still starts under the first row's text and no number can be selected or copied with the code; past two thousand lines a block keeps its text and loses its gutter, because a pasted file is a code block too.

  **Inline code is a chip** — monospace, a tint, a thin edge, its own ink — the way Atlassian's editors draw one, so a `--flag` inside a sentence is visibly not the sentence.
  Not tokenised, and that is the whole of what "highlighting inline code" can mean here: there is no language on an inline span, and guessing at one colours English prose as if it were code.

  **A note that ends in a code block has a way out of it** (`editor/rich/tail.ts`).
  Every click in the empty space below landed at the nearest position there was, which is *inside* the block, so typing added a line to the code sample and the only way out was a keyboard shortcut you had to know.
  There is now a strip under a trailing block — a real button, so the keyboard has the same way out the mouse does — and a click anywhere below the content means the same thing.
  What it is not is a trailing paragraph kept in the document: an empty paragraph at the *end* of a document is written as nothing (one between two blocks is a blank line in the file), so a paragraph parked there would be a difference between the note on screen and the note in the file that nothing would reconcile.
  The offer is made as the app's change rather than the user's, so clicking it and thinking better of it leaves the note unchanged and undirtied, and the paragraph is withdrawn when the cursor leaves it still empty — only ever the one this plugin offered, never an empty paragraph that came from the user's own file.

  **A block that names no language says "Detect language", and means it** (`editor/features/code/detect.ts`, `editor/features/code/autoLanguage.ts`).
  Select something, press the button, and the fence comes with a language already in it; a block started empty works it out as it is typed or pasted into.
  Three rules keep the second one from being a nuisance, and each is one line of the plugin: only the block holding the cursor, so a keystroke in a paragraph does not go off labelling a fence further down; only on a user transaction, because a body arriving from sync or from raw mode is the app putting text in and a note nobody edited has to come back byte for byte (§7); and only while the block names nothing, which is also what makes it terminate.
  The guess rides in the same transaction as the edit that prompted it, so one undo takes back both and the dirty rule attributes it to the user — it is their keystroke that put a word in their file.

  Signatures and a threshold, not a library: `highlight.js` does this by running every grammar and counting how badly each does, which means shipping every grammar — the cost `editor/features/code/languages.ts` exists to avoid — and it is BSD-3, which this repo does not take.
  What is here instead is about seventy patterns over twenty-two languages, one pass over at most four kilobytes, no dependency.
  JSON is not guessed at but checked, since a body that parses is JSON and a body that does not is not.

  **It is built to say nothing.**
  A language has to score four — one decisive giveaway like a shebang or `<?php`, or two or three ordinary ones — *and* beat the runner-up by two, so Java against C# and C against C++ come back blank from five lines rather than coming back wrong.
  The bias is the note preview's bias (§7) applied to a different question: a blank picker costs a click, and a confident `python` over somebody's pseudocode is a word in their file they have to notice before they can undo it.
  The suite that matters is the second one in `tests/detect.test.ts` — prose, a path, a number, a list of names, a sentence with a colon in it — because a notes app is mostly those.

  Two things the tests found and the patterns now say: a command with a `$` prompt in front of it is still a command, and JSX is evidence *for* JavaScript rather than for HTML — without that, a React snippet tied with HTML on closing tags and the margin rule sent both away empty-handed.

  **The floating toolbar stays away from a code block.**
  Selecting a few words of a code sample used to bring up the bold/italic/code bar over them, and every button on it was a no-op: the schema says a code block holds no marks.
  The bar across the top greys those buttons in the same situation, which is the option a permanent toolbar has; a bar that only exists when there is a selection has the better one, which is not to appear.
  Milkdown's `TooltipProvider` takes a `shouldShow` that *replaces* its own predicate rather than extending it, so `InlineToolbar.tsx` restates the four cases it already refused for — no focus, an empty selection, an empty text block, a read-only note — and adds this one.

  **The toolbar has one insert button now**, which reverses what its own comment said when it was written a day ago: insert belonged to the slash menu and was deliberately not duplicated.
  The code block is the exception because it is the construct people go looking for in a toolbar, and because the block has more to it than its own existence — a language, and the colours that follow — so somewhere to press is somewhere to start.
  It is a toggle: lit inside a code block, and pressing it again gives the block back as plain text.
  The mark buttons are grey in there, since the schema says a code block holds no marks and a lit button that does nothing is worse than one that is grey.

- **A `<br />` inside a sentence no longer sends a note to raw mode (2026-09-23).**
  Reported: adding one showed the banner saying the rich editor could not show the note.
  The check was right — the editor deleted it — and the cause was Milkdown's reader for the empty paragraph taking every `<br>` in the note (§7, "An empty line is a blank line").
  Now only the editor's own shape is an empty paragraph, and every other break comes back as it was written.
  A second, smaller cause sat behind the first: the serializer writes a line ending before inline html as a space, which the fidelity comparison counted as a difference, so a `<br />` on its own line inside a paragraph still failed; the comparison now reads it as the serializer writes it (§7, the fidelity bullet).

- **The raw-mode banner says what the rich editor cannot show, and the rich editor can be asked again (2026-09-23).**
  The banner said only that the note used "markdown the rich editor has no way to show", and the note then stayed in raw mode for as long as it was open, whatever the user did about it.
  It now names the first thing the editor would drop and its line (`the HTML <br> on line 3`, `a link reference definition on line 5`), and once the note has changed the rich tab is offered again and checks again (§7, the fidelity bullet).

- **A first import says how it is going, holds the app, and can be cancelled (2026-09-23).**
  Connecting on a device with many notes, or to an account with many, showed "Syncing…" for minutes and nothing else, and nothing could stop it.
  The import now counts what it finds, downloads and uploads — over the app for the first source, which is held until it is through, and in the storage panel for a later one — and Cancel puts the device back as it was.
  §6, "A source's first import"; §7, the sync loop.
- **Where the user was, where a note starts, and what a row says (2026-10-01).**
  Five refinements to the note list and the note beside it, one commit each:
  - *The list is ordered by when each note was made*, newest first, so editing a note no longer moves its row to the top under the pointer (§7, "Re-arranging is moving").
  - *A row's preview is the note's visible text*, by a parse rather than a pass over the string — no `**`, no link URLs, no `<br />` lines — kept by body so a body is parsed once, with a pipe where one line ends and the next begins (§7, Editor).
  - *Nor does it repeat what the row already says* (2026-10-05).
    The title is passed over where the body opens with it, and so is a line saying only when the note was made (`store/createdLine.ts`), above the title or below it, with a time of day on the line after it: OneNote and its exporters put one under every page's title, and in a library exported from OneNote it was the whole preview of all but one of 1,028 notes.
    It is read as words, not by `Date.parse`, which reads such lines differently in each engine.
    Once at most one time of day is taken out (a second is an event, not a creation time), the numbers must be the note's year, month and day, each once, the month as a number or a name, and in that order where the year comes first (`2014-03-02` is not the 3rd of February); every other word must be that month's name, a weekday's, a word a language puts in a date (`de`, `den`, `г`, `年`, `um`, `下午`, as `Intl` spells them) or an ordinal's end; and nothing may be left but a date's punctuation, so `$20 – Feb 2014` is the user's.
    Names are those of the reader's languages and English, in the Gregorian calendar, a month in both the form it has alone and the one a date gives it (`февраль`, `февраля`); the day is the note's in this time zone or in UTC; a line over 80 characters is not read at all.
    A note dated by its import names that day nowhere.
  - *The app opens where the user was.*
    Per source and on this device, in `prefs` (`store/lastOpen.ts`): the notebook open last, and the note open last in each notebook.
    The URL still wins when it names something there; otherwise the remembered place, else the first notebook and its newest note — first and newest as the lists have them, a pinned one before the rest (§7, "Pinned to the top").
    A notebook with no notes of its own opens on the first note its list shows, from the notebooks inside it in the sidebar's order, pinned notebooks and pinned notes first (2026-10-11).
    Before, it began a note beside them, and its list was then a new note above notes it did not hold.
    One path decides it for every way a notebook comes to be showing — clicked, restored at start, a source shown again, fallen back to after a delete, a first import filling it — where opening a note used to follow a click and nothing else, so a notebook the app opened by itself showed an empty pane (§12.6).
    What this tab has written is handed out ahead of the store's answer until the store has been read since it landed (`lastWritten`, 2026-10-08, #283), as a typed name is until the store has it: Dexie starts a live query over for each write that lands while it reads, and a click writes once or twice, so under load the answer ran clicks behind — a notebook clicked back to opened on its newest note, and that was remembered over the note left open there.
    A write from another tab that lands after this tab's is read over it; one that lands before is in this tab's already, since a write reads the place and writes it back in one transaction.
    A tab writes its place when the place moves, not whenever the memory says something else: two tabs showing two notebooks of a source were each told by the memory that the user was in the other's, and wrote their own back over it, over and over for as long as both were open (#305).
    The place on record is the last one either tab moved to.
    Whether a move changes the memory is asked of the row inside the transaction that writes it, not of the live answer, which can be a write behind: a tab that moved and straight back would be taken to be where the memory said, and its first move would land after it.
  - *A note begins unstored.*
    `+`, and a notebook with nothing in it, begin a note on screen and at the top of the list, named "Untitled" with the name selected to be typed over; Enter in the name moves to the text.
    It is stored at its first edit, under the id and creation time it was begun with, so autosave and rename find it as they would any note; left unedited, nothing was written.
    It cannot be moved or deleted until then, since leaving it is what deleting it would do.
    In a compact window the dropdown shuts for it however it began — a notebook made, a notebook's last note deleted — since the cursor goes to its name and a name under a dropdown cannot be typed into.
    None begins in the loose notes, which the app never adds to, or while a first import is still bringing a notebook's notes in (§12.6).
  - *A row says what is being typed as it is typed*, not when autosave has stored it (§7, Editor).
- **The compact bar's dropdowns, and a rename that changes only the name (2026-10-01).**
  Three refinements, one commit each:
  - *A dropdown is its words and a chevron, and its panel opens out of it.*
    The triggers were boxed, which on a phone read as three fields, and their panels appeared and vanished with nothing to say which trigger they belonged to (§7, the layout).
  - *A dropdown stays open for a menu or a dialog opened from it.*
    The notebook's `⋯` menu and the delete question are drawn over the app rather than in the panel, so a press in either counted as a press outside the panel and shut it: Rename put its field in a panel that was no longer showing, and had to be found by opening the panel again.
  - *A rename changes only the name.*
    The field took a box of its own in place of the row, which dropped the count and the highlight and, on a touch screen, a quarter of the row's height.
- **The compact bar as a path (2026-10-02).**
  Two refinements, one commit each:
  - *The dropdowns are as wide as their names, with the chevrons between them*, and the open one's chevron is lit; they had a third of the bar each (§7, the layout).
  - *A choice in one dropdown opens the next*, sliding along to it, so a source chosen goes on to its notebooks and a notebook to its notes (§7, the layout).
- **Formatting on a phone (2026-10-02).**
  Three refinements:
  - *The `Format` bar stays as it was left*, on this device, across a reload (§7, the layout).
  - *The bar's menus are in the top layer*, over everything, capped to the room the keyboard leaves and scrolling inside; `More tools` had its first items cut off under the note's title (§7, the layout).
  - *The floating selection toolbar keeps off a touch screen*, which has a selection menu of its own (§7, Editor, "Menus").
- **An empty list item is its marker alone (2026-10-02).**
  Enter after an item showed `- <br />` in the markdown, and an empty item an author wrote could not be opened in rich text (§7, "An empty line is a blank line").
- **An empty line is a blank line, not `<br />` (2026-10-04).**
  Reported: Enter in an empty note, then the markdown, then rich text again, and the note was held in raw mode over "the HTML `<br />` on line 1"; and the `<br />` itself, written for every empty line, was not wanted in the file.
  An empty line between two blocks is now one more blank line there, read back from the gap; at the top or bottom of a note it is nothing; an empty task item keeps `- [ ] <br />` (§7, "An empty line is a blank line").
- **A picture selected on a phone can be taken out (2026-10-04).**
  Reported: tapped and outlined, it stayed put on Backspace on Android.
  A delete the keyboard asks for with an input event now deletes a node selected whole, and a selected picture has Remove from note, as a chip has (§7, "Pictures beside a note").
- **A notebook's attached files (2026-10-04).**
  A file no note links any more was kept and never shown.
  A notebook's menu lists its files, says which notes link each one, and deletes one that none does (§7, "Files in the library").
- **Which storage a source is, at a glance (2026-10-04).**
  Asked for: each provider's mark in front of a source's name, and on a phone the source dropdown as the mark alone (§7, "Each source shows which storage it is").
- **A file taken out of a note goes after it (2026-10-04).**
  Three minutes after the note is left, and after a pull since, a file the visit took out of it is deleted if no note in the source names it, where the device holds every note in the source (§7, "Files in the library").

## Phase 8 — Public repo + self-hosting
- `LICENSE` (AGPL-3.0), `TRADEMARK.md`, `CLA-individual.md` (adapted Apache ICLA + Harmony reciprocity clauses), `CLA-entity.md` (adapted Apache CCLA, held until needed), `CONTRIBUTING.md` explaining the CLA and why it's a grant not an assignment, `CODE_OF_CONDUCT.md`, and `SECURITY.md`.
  The copyright notice goes in a `NOTICE` file and a `"license"` field in each `package.json`, **not** into `LICENSE` — this checklist used to say "fill in the LICENSE appendix copyright", which was wrong: the appendix is an instruction telling you to attach that notice to *source files*, and editing it leaves `LICENSE` no longer a verbatim copy of AGPL-3.0, which its own header forbids and licence-detection tooling reads.
  Every legal text carries a visible "draft, not reviewed by counsel" header and **stays a draft until a lawyer has read it** — they are written so that review has something to correct rather than a blank page, not so that it can be skipped.
  Two things a reviewer should be pointed at first: the CLA names the Project as "Skysa" throughout and the legal entity behind that name is not yet settled; and the Code of Conduct states two real gaps rather than papering over them — there is no private conduct channel at all (the repository's vulnerability reporting is a security-advisory mechanism and the wrong shape for one), and with a sole maintainer a report *about* that maintainer has nowhere impartial to go.
  Both are fixed by publishing a named contact who is not the person a report might be about, not by rewording
- `contributor-assistant/github-action` wired to `CLA-individual.md`, failing its check for an unsigned contributor.
  **Failing is not blocking**, and the difference is an operator task, not a file in this repository: the `main-protection` ruleset requires no status checks at all today, so an unsigned contributor's pull request is merge*able* with the CLA check red.
  Adding `CLA` — and `verify` — to the required checks is what closes it, and that is named in the repo-hygiene item below.
  Signatures go in a **`cla-signatures` branch of this repository**, which has to be created before the gate works at all — the action does not make it, and answers `Branch cla-signatures not found` until it is there; it was created by hand on 2026-09-18 after the first real pull request failed on exactly that.
  Chosen over the separate private repository an earlier draft of this checklist called for: a private one needs a personal access token provisioned before the gate works at all, and what is recorded — a GitHub login and user id, the signing comment's id and timestamp, the pull request number — is already public about anyone who has commented on a pull request here.
  Chosen so the gate works on a clean clone with no secret to set up.
  The action itself is **archived upstream**: self-contained enough to read in full and to replace rather than patch, which is the trade it is accepted on, and the reason is written into `cla.yml` where whoever hits it will be looking.

  The workflow runs on `pull_request_target`, which is the one thing to be careful of: that event runs the workflow file **from the base branch**, with a writable token, in the base repository's context.
  It has to, because a fork's `pull_request` token cannot write the signature branch.
  So `cla.yml` never checks out or executes the pull request's code, and must not be given a step that does — anything running a contributor's code there hands a writable token to whoever opened the pull request. https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- `docs/self-hosting.md`: Cloudflare account, `wrangler login`, D1 create + migrate, `wrangler secret put` for each key, registering Google/Entra/Dropbox apps named `skysa-notes` with callback URLs, Google's Testing status (test users, 7-day refresh tokens) and publishing with non-sensitive scopes (`docs/google-oauth.md`), custom domain
- `pnpm run setup` script that prompts for provider credentials and writes secrets; `pnpm run deploy` = build web + `wrangler deploy`.
  **The `run` is load-bearing:** `setup` and `deploy` are both pnpm built-ins, so a bare `pnpm setup` runs pnpm's own installer instead.
  Named as the checklist named them, since `pnpm run <name>` works and a different name would have been a worse thing to document; every doc that mentions them writes the `run`.
  `apps/api` keeps a `deploy:migrate` that applies remote migrations first, for when the two should go together
- Verify a clean clone deploys end to end on a fresh Cloudflare account — not yet done; issue #119
- GitHub Actions: format, lint, typecheck, the whole test suite (contract and round-trip included) and `wrangler deploy --dry-run`, on every PR and every push to `main`
- Changesets for versioning, tags `vX.Y.Z`.
  The three workspace packages are `fixed` to **one** version: they are not three libraries but one deployment, and a web bundle that does not match the Worker it talks to is not a thing this repository produces — so there is one number, and it is what the tag names.
  Nothing is published to npm (all four packages are `private`, `changeset publish` is never run); the release *is* the Cloudflare deploy, and the tag exists so a deployed instance can be traced to a commit.
  The version is not cosmetic: `apps/web/vite.config.ts` reads it into `APP_VERSION`, which is written into the marker file in the user's own storage.
  The root `package.json` lost its `version` field in the same change — it is not a workspace package, so `changeset version` never touches it, and a number there that nothing updates is a second and wrong answer to which version this is.
  `.github/workflows/release.yml` cuts the tag when it sees a version on `main` that has never been tagged; versioning itself is a local step (`pnpm run changeset:version`) reviewed as a pull request, **not** the Changesets bot — a pull request opened with `GITHUB_TOKEN` starts no workflows, so its own CI would never run, and once `verify` is a required check a pull request whose checks cannot run can never merge.
  CI asks a pull request that changes a package for a changeset; `--empty` is the answer when nothing observable moved.
  Two shapes are exempt because neither can answer, and the first would otherwise be the same gridlock arriving from the other side: the **release pull request itself** — `changeset version` deletes every changeset it consumes, so its diff is three bumped packages and nothing explaining them, which is exactly what the check rejects — and a **dependency bump**, since Dependabot cannot write a changeset and a rule that reddens every dependency pull request is one people learn to ignore.
  Recognised by shape rather than by branch name, which anyone could adopt: nothing changed in a package but its `package.json` and its `CHANGELOG.md`.
  The release itself is cut by `release.yml` on the version reaching `main`, which means **merging the changesets work tags whatever `main` then carries** — `v0.1.0`, the version already in the tree
- Repo hygiene: Dependabot (npm + actions, weekly, grouped — **majors left out of the group**, since a major is a decision and bundling one with a pile of patches means the decision gets merged without being made; left out of a group is raised separately, which is not the same as `ignore`d, and `ignore` would hide them), issue templates, a pull-request template, `CODEOWNERS`, `SECURITY.md`.
  Three things here are repository settings rather than files and stay operator tasks, each with something in the tree already waiting on it: the `main-protection` ruleset requires **no** status checks today, so `verify` and `CLA` have to be added there before either gates anything; private vulnerability reporting is off, which is why the issue chooser links `SECURITY.md` and its fallback rather than the advisory form, which is unreachable for a non-maintainer; and Discussions is off, which is why the chooser has no Discussions link — add one back when it is on

## Cleaning up after account-first (2026-09-18)
Sign-in separate from storage was Phase 9 and is **not being built** (§6, "No sign-in separate from storage"; §14 keeps the reasoning).
Removing the plan leaves scaffolding in the tree that now has no caller, and it is listed rather than left to be found:
- Drop the `users` and `identities` tables, drop `AUTH_MODE`, and drop the client's `account-first` branch in the storage panel (`components/account/NotConnected.tsx`) — issue #118, which carries the list of every site the env var reaches, since a grep for one name will not find them all.
  Each is its own change; dropping the env var is breaking for anyone who has it set
- Drop `signin`, `conflict` and `occupied` from `CONNECT_OUTCOMES`.
  Phase 7 retired all three server-side — `Outcome` in `routes/connect.ts` is `ok | denied | failed | partial` — and `signin` rendered "Sign in before connecting storage", a message for a product that does not exist.
  Done in the same change as this decision, because it was the last user-*visible* thing in the tree implying a sign-in

**A bug that removing them exposed, and its cause.**
With `signin` gone from `CONNECT_OUTCOMES`, a stale `?connect=signin` still reached the component and rendered an empty alert banner.
The cause was ours, not the router's: TanStack Router builds what `useSearch()` returns as `{ ...parentSearch, ...validated }` (router-core `matchRoutesInternal`), the root route validates nothing so `parentSearch` is the raw query — each value already through `JSON.parse` — and `parseSearch` *omitted* a refused key instead of overriding it, so the raw value survived the spread.
`validateSearch` was therefore never in force for a refused value, only for the types.
The same hole made `/?note={"a":1}` a crash by link: the object reached `db.notes.get`, the live query threw during render, and with no error boundary the whole app was replaced by the router's fallback.
`parseSearch` now returns every key, `undefined` when refused (`stringifySearch` drops those again, so nothing is written back to the URL), and `tests/routes.search.test.tsx` asserts what the component receives through the real route tree — the unit tests called `parseSearch` directly with `toEqual`, which cannot tell a missing key from an `undefined` one, and is why this went unseen.
The `default` in `connectMessage` stays for a build older than its API.
Separately, the root and index routes carry an `errorComponent` (`ErrorScreen`), so a render error says the notes are safe and offers Reload and Try again instead of taking the app down.

Kept from that phase because neither was ever about identity:
- Abuse controls for a shared instance are an operator's to supply behind the rate-limit seam (`createApp({ rateLimiter })`), for token minting and connection changes; the per-connection grant cap is done (§6).
  Not scheduled here — a personal instance does not need it, and what a shared one needs depends on who is running it
- Account deletion is **done**, and was done per silo rather than per user: `DELETE /api/connection` revokes at the provider where supported and deletes the row.
  The Phase 9 item asked for the version that spanned a user's several connections, which is not a thing that exists any more
