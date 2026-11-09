# 0018. The shared kit

*2026-11-09. Planned; nothing has moved yet. Cited in the code as §13, "The shared kit". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

The layers of this app that do not care what a file holds are to move to a repository of their own, `skysa-org/skysa-kit`, published to npm.
This app, [skysa-draw](https://github.com/skysa-org/skysa-draw) and [memoriam](https://github.com/skysa-org/memoriam) will depend on it.
Every storage option, today's three and any added later, is built there and nowhere else.

**Why now.**
Both sibling apps began as copies of these layers.
skysa-draw copied them from v2.1.1 and wrote down where each piece came from ([its record 0002](https://github.com/skysa-org/skysa-draw/blob/main/docs/decisions/0002-carried-over-from-skysa-notes.md)), naming the trigger for a shared package: the first change that has to be made twice.
Memoriam has passed it: ported from an earlier commit, it carries this app's later fixes to the engine and the adapters by hand.
And the copies no longer match each other letter for letter.
skysa-draw respelled its comments, memoriam is on an older base, and each has fixes the others lack, so a fix stops being a patch that applies in three places.
Both apps are also meant to be hosted as this one is, through `createApp` and the seams a deployment passes it (§6, "Entitlement seam").
Memoriam cut the entitlement policy, the connect gate, connect codes and the change relay on the way; as a copy it would have to port them back, and as a dependency it has them.

**What moves, and where to.**
Seven packages, with one version between them:

| Package | What it holds | From here |
|---|---|---|
| `@skysa/protocol` | What the server, the client and a deployment all speak: the API's error codes, the entitlement, gate and rate-limit seams, the relay's frames, `PROVIDER_KINDS` | `packages/core/src/{api,entitlements,relay}.ts`, and `PROVIDER_KINDS` from `config.ts` |
| `@skysa/storage` | The adapter interface and its errors, one folder per provider, and below them names, paths, the marker and hashing; `/testing` has the fake, the wire stubs and `describeProviderContract` | `providers/`, `names/`, `paths.ts`, `marker.ts`, `hash.ts`, `json.ts`, `cell.ts`, `files/mediaTypes.ts` |
| `@skysa/sync` | The engine and its store port, over a document format the app supplies; `/testing` has the in-memory store, `describeSyncStoreContract` and the simulation kit | `sync/` |
| `@skysa/server` | The Worker as a library, one connect flow per provider, and the D1 migrations | `apps/api/src` but `worker.ts`, and `apps/api/migrations` |
| `@skysa/client` | The API client, the token source, the provider factory and its request deadlines, the scheduler, the relay client, and the connect code a device holds | `apps/web/src/api/`, `sync/{tokens,providers,relay,scheduler,wakeLock,beforeUpdate}.ts`, `store/{credentials,connectCode}.ts` |
| `@skysa/pwa` | The brand's Vite plugin, the manifest, the bundle budget, and a check of `_headers` | `apps/web/{brand,pwa}.ts`, `apps/web/scripts/` |
| `@skysa/eslint-config` | The lint rules the apps share, `tsconfig.base.json`, and Prettier's settings | the root |

None of the names is one of this app's (`@skysa/core`, `@skysa/api`, `@skysa/web`), so a deployment that imports those goes on doing so.

**What stays here.**
The note: the markdown pipeline and frontmatter, and with them how the engine reads a note's `id` and writes a conflict copy.
Secrets, the vault, the clipboard and the scratchpad.
The editors and every component.
The Dexie schema and the `SyncStore` over it, since each app's database has its own version history.
How a device holds its sources, a silo per account here and in skysa-draw and one library in memoriam, which is each app's own.
Every word a user reads: the kit answers with codes, and each app words them through its own `t()` (§7, "The app's words").

**Every storage option is built in the kit, whole.**
A provider is four parts, each under its kind's name:
- the adapter, in `@skysa/storage`;
- its connect flow, OAuth or a form of credentials, in `@skysa/server`, with the settings it reads, as `OAUTH_ENV` names them now;
- its wire stub, and its live registration in the contract table;
- a page on registering it with the provider, which is what §5 and `docs/google-oauth.md` are now.

A test holds every provider the kit implements to all four, as the compiler now holds `OAUTH_ENV` and the flows to each other.
Each provider also has a descriptor that every side reads:
- how it connects, `oauth` or `credentials`;
- whether content goes to the provider directly or through the Worker, `direct` or `proxied`;
- whether its ids survive a move;
- whether an account's id is the same in every app registered with the provider (Google's and Dropbox's are) or not (Microsoft's).

An app never switches on a kind.
The kit's client makes the adapter and the token source from the descriptor.
The app lists the kinds it supports and gives each a label and a mark, and its records are typed over that list, so a kit release that adds a kind breaks no app's build.
What a user is offered is what the operator enabled (`ENABLED_PROVIDERS`), less what the kit does not implement and what the app does not support.
So a new storage option is a minor release of the kit, and an app has it once it bumps the kit and adds the kind to its list.

- **A kind is data.**
  It is written into the marker, into each device's rows and into `storage_connections.provider`, so a kind is only ever added, never renamed.
  That column is text with no `CHECK`, so adding a kind needs no migration, and it is to stay that way.
  Whether a build that does not know a kind could take a marker naming it for a damaged one is to be checked when the marker moves.
- **A proxied provider is where content would pass through the Worker** (§5.4), the one exception the privacy promise in §1 already names.
  It is off unless the operator lists it, and `/api/config` says which kinds are proxied.
  The proxy, which streams and keeps nothing and refuses to reach private addresses, is the kit's, written once for every such provider.
  WebDAV stays deferred; the seam is there for it, and the design in §5.4 moves with it.

**The seams, cut here before anything moves.**
Each is a pull request of its own in this repository, released as usual, so that moving the code is a move and not a rewrite.

- **The app's folder is described, not imported.**
  Its name, the marker file with the app and the layout version the marker names, and the key Drive tags the folder with are one value, `AppFolderSpec`, that each app hands the adapters.
  The scheduler is handed the name of its sync lock the same way.
  This app hands over exactly what it has now, and a test pins each one: renaming any of them leaves every library already connected unfound, as §8, "Brand", says of the brand.
  Nothing else needs handing over.
  The server's flow cookies are `__Host-` cookies, and the update channel and the key a connect code is kept under are the browser's: each belongs to one origin, and every app is served from an origin of its own.
  The IndexedDB name stays with each app's database.
  The type is not called an identity, a word this repository keeps for the sign-in it decided against (§6, "No sign-in separate from storage").
  This one is cut: the type is in `packages/core/src/folderSpec.ts`, this app's folder is `NOTES_FOLDER` in `config.ts`, and its lock is `SYNC_LOCK` in `apps/web/src/sync/lock.ts`.
  The fake works in a folder that is no app's, `TEST_FOLDER`, so the engine's whole suite runs without this app's names, and a lint rule keeps them out of `providers/`, `marker.ts` and `folderSpec.ts`.
- **A document format, not a note.**
  This is skysa-draw's seam (`sync/document.ts` there): a document's extension and media type, the id a file claims, a conflict copy's contents, and every read that holds a file as a document.
  Here it is over `NOTE_EXTENSION`, `text/markdown`, `parseNoteFile` and `serializeNoteFile`, and the layers that move take them from it rather than importing them.
  This one is cut: the type is `DocumentFormat` in `packages/core/src/documentFormat.ts`, this app's is `NOTE_FORMAT` in `markdown/format.ts`, and the engine and the adapters are handed it.
  The names they use are made from its extension (`documentNames`), and this app's own are `names/notes.ts`.
  A format may refuse text as not a document, which the engine holds as unreadable, as skysa-draw does with a `.svg` that is not a drawing; this app's refuses none.
  The in-memory store and the store contract, which go with the engine, are handed the format too, and the Dexie store, which stays, makes notes' copies (the client's ports, part 3, below).
  A lint rule keeps `markdown/`, `NOTE_EXTENSION` and `names/notes.ts` out of `providers/`, `sync/` and the names they share.
- **A merge before a conflict copy, where the app can make one.**
  This is memoriam's optional `merge({ path, local, remote })` and its `merge-note` change, with their store-contract cases.
  This app passes none, and its conflict rule (§7, "Conflict rule (concrete)") is unchanged.
  This one is cut: the option is `SyncEngineOptions.merge`, asked in `sync/pull/notes.ts` and `sync/push/conflicts.ts`, and the scheduler passes it through (§7, "Merge before the copy").
  Both stores here apply `merge-note` and the contract holds them to it, so the kit's stores start with memoriam's rules.
  memoriam's own merge, `mergeFile`, stays in memoriam.
- **Which hidden paths sync, and which a pull should mention.**
  `syncsHidden(path)` takes the place of the folders `paths.ts` lists, the scratchpad's and the vault's.
  `watch`, a set of named tests of a path whose flags the outcome carries, takes the place of the clipboard's and the key file's flags in `sync/outcome.ts`.
  This one is cut: `paths.ts`'s `isHidden` is any app's now, hiding every dot-named segment, and the engine takes `syncsHidden` and `watch`; a pull says by name what it met (`SyncOutcome.met`).
  This app's are in `appFolder.ts`: `syncsHidden` lets `.scratchpad/` and `.vault/` through, `isPassedOver` is the rule its own screens and import ask, and `NOTES_WATCH` names the clipboard's folder and the key file.
  What syncs is exactly what synced before, so no cursor is dropped.
  The scheduler requires `syncsHidden`, since without it a scan would forget the scratchpad's and the vault's clean notes.
  It set the watch itself until the clipboard's and the key file's syncs were attached to it by the app, which now hands it the watch with them (below).
  A lint rule keeps `appFolder.ts` and those places' names out of `paths.ts`, `providers/` and `sync/`.
- **When a push goes.**
  A scheduler option, with memoriam's lazy writes as one setting and this app's two seconds after the last edit as the default.
  This one is cut: `queueWrite` takes a `timing`, and the scheduler sends a lazy write with the next sync, and `lazyMs` after it at the latest, where it is given one (§7, "When a push goes").
  This app gives none and queues nothing lazily, so its edits still go two seconds after the last.
  Hiding the page sends whatever is waiting, here as in memoriam, so an edit made just before the app goes out of sight no longer waits out its two seconds in a page a phone may have frozen.
  A write the Dexie store owes again, because the note changed while it was on its way, is queued as lazily as the one that landed.
- **The client's modules reach IndexedDB through ports**, with Dexie adapters over tables the app owns.
  This one is cut in five parts, each a pull request of its own.
  1. What the app syncs beside its documents is the app's (`sync/notesSync.ts`).
     The scheduler builds none of it: the clipboard, the key file and the files beside notes are made by the app over the session the scheduler lends (`sessionFor`), and attached to it (`attach`), to be told when a session starts, syncs and ends.
     The app hands it the watch, `NOTES_WATCH`, beside the two that read it.
     This part is cut.
  2. The scheduler and the provider factory say nothing in words of their own.
     A failure the engine gives no reason for is published with none, and the app's status words say it.
     A provider this build has no adapter for is `attention` with no error, which the app already words from the kinds it syncs.
     A request given up on fails with a `TimeoutError` that says what the app hands the factory (`timedOut`), since that message goes through the engine and is kept on an op that fails with it.
     The catalog's `scheduler` words, which nothing reached, are gone.
     This part is cut.
  3. The stores that move take the format, and make a conflict copy with it.
     The in-memory store and the store contract are handed it, and the contract's in-memory run uses a format that is not notes', so that a store reading markdown for itself shows.
     The Dexie store is not handed one: it stays with the app, and reads each file into a note's row, frontmatter and all, so a format it was handed could only be notes'.
     A lint rule holds the two that move to what the engine is held to.
     This part is cut.
  4. The credential, the token source and the relay reach the database through ports.
     The credential's functions are over a `CredentialTable` (`get`, `put`, `delete`), held by whatever is handed them, and the app's database fits as it is; the credential's row type is theirs now.
     The token source is handed that and a `TokenStates`, which reads whether a connection is let go and the token kept for it, and keeps or forgets one onto a live row.
     The relay is handed the credentials.
     The app's adapter for the token's row is in `sync/dexiePorts.ts`, not `store/`, since the store layer may not import the sync layer's types.
     This part is cut.
  5. The scheduler reaches the database through one port, and none of what moves imports the app's `store/`, Dexie or its words.
- **The forks' fixes come back first**, so that the kit starts with every fix any of the three has, memoriam's checks of the root in the contract suite among them.
- **A lint rule fences what is to move** from what stays, and once it passes the move can be made.

The operator's seams do not change: `EntitlementProvider` with its gate, `checkCode` and `hold`, `RateLimiter`, `RelayHub`, `ENABLED_PROVIDERS` and `RELAY`.

**How it is published.**
- On npm, as `@skysa/*`: built to JavaScript and declarations, ESM, with provenance.
  This repository's own packages stay private and unpublished (`.changeset/README.md`); the kit is the one that publishes.
  The error codes and their `isXError` guards (§4) were written for the day core is published and a consumer holds two copies of it.
- One version for all seven and one `vX.Y.Z` tag, with Changesets, as here.
  An app pins it exactly and bumps it on purpose.
- The kit carries this repository's migrations under the same names, `0000_init.sql` to `0006_grant_device.sql` and then #118's, so a database that has applied them meets only what is new.
  An app points its `migrations_dir` at the package's.
- The repository is made with `git filter-repo` over the paths that move, so that their history and blame go with them, and an issue number in a comment becomes `skysa-notes#N`.
- The sections that describe what moves go to the kit's own `ARCHITECTURE.md`, with [record 0003](0003-change-relay.md): §4, §5, §6, the engine's part of §7, the brand's part of §8, and §9's server items.
  Each keeps its heading and anchor here, with a sentence saying where it went, so every citation in the code still leads somewhere, as [the index of records](README.md) does for the records.
- AGPL-3.0-only, with the same CLA, for the reasons §13 gives for this repository: the server is where the network clause matters.
  The CLA's text and its signature records have to cover the new repository before anything is merged there.

**In order.**
1. The seams above, here.
2. The kit's repository, its CI, the CLA and the documents, and 0.x on npm.
3. This app depends on it and deletes what moved.
   `@skysa/api` keeps exporting `createApp`, `parseEnv`, `AppConfig` and `@skysa/api/relay`, and `@skysa/core` the seams' types, so a deployment's own Worker entry builds unchanged.
   Before that release: the bundle against its budget (`pnpm size`), since tree-shaking now crosses a package's edge; the live provider suites; and a check on staging.
   The kit is 1.0.0 once this reaches production.
4. skysa-draw depends on it, and its record 0002 is superseded.
5. Memoriam depends on it, and has the entitlement seam, the gate, connect codes and the relay back without porting them.

Later, where two apps show the shape: frontmatter (this app and memoriam), a device's sources as silos (this app and skysa-draw), the catalog's machinery, and the gate's logic without its screens.

**For whoever hosts more than one of these apps.**
One Worker and one origin per app: the Content-Security-Policy, the device's credential and its IndexedDB each belong to an origin, by design (§6, "Per-connection credentials").
Each app is registered with each provider on its own.
Google revokes per Cloud project, so a project shared by two apps would let disconnecting one take away the other's access, and Dropbox and OneDrive name the app folder after the registration.
Where anything is keyed on a storage account, the descriptor's account-id rule says whether the same account can arrive from two apps under one id.

**Open, and decided when its step comes.**
- Whether #118, which is breaking, ships in the same major release as step 3.
- Whether skysa-draw's and memoriam's D1 databases are reset onto the kit's migrations (steps 4 and 5): their `0000_init.sql` has this repository's file name and not its contents.
- Which spelling the kit's comments keep (step 2): this repository's British, or skysa-draw's American.
- The `@skysa` organisation on npm has to be claimed before step 2.
