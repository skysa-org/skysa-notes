# 0018. The shared kit

*2026-11-09. Steps 1 and 2 are done, and step 3's move is made (2026-11-11), to ship as 3.0.0. Cited in the code as §13, "The shared kit". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

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
| `@skysa/protocol` | What the server, the client and a deployment all speak: the API's error codes, the entitlement, gate and rate-limit seams, the relay's frames, `PROVIDER_KINDS` | `packages/core/src/{api,entitlements,relay,providerKinds}.ts` |
| `@skysa/storage` | The adapter interface and its errors, one folder per provider, and below them names, paths, the marker and hashing; `/testing` has the fake, the wire stubs and `describeProviderContract` | `providers/`, `names/` but `notes.ts` and `slug.ts`, `paths.ts`, `marker.ts`, `folderSpec.ts`, `documentFormat.ts`, `hash.ts`, `json.ts`, `cell.ts`, `bytes.ts`, `files/mediaTypes.ts` |
| `@skysa/sync` | The engine and its store port, over a document format the app supplies; `/testing` has the in-memory store, `describeSyncStoreContract` and the simulation kit | `sync/` |
| `@skysa/server` | The Worker as a library, one connect flow per provider, and the D1 migrations | `apps/api/src` but `worker.ts`, and `apps/api/migrations` |
| `@skysa/client` | The API client, the token source, the provider factory and its request deadlines, the scheduler, the relay client, the connect code a device holds, a long run's count, and the stores a screen listens to | `apps/web/src/api/`, `sync/{tokens,providers,relay,scheduler,wakeLock,beforeUpdate,progress}.ts`, `store/{credentials,connectCode,emitter}.ts` |
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
  This one was cut in five parts, each a pull request of its own, and all five are cut.
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
     The port is `ClientStore`, in `sync/scheduler.ts`: the source shown, the connection's row (its root, when a pull last reached the end, the first import, a re-scan), the queue (its seqs, what came after one, the ops out of attempts and giving them back), the engine's store, the credentials, the token's row, what this tab waits on, and the queue's limit on attempts.
     The app's adapter is `clientStoreOf` in `sync/dexiePorts.ts`, and `createNotesSync` hands it over.
     A lint rule kept Dexie, the app's tables and stores, and the catalog out of the modules in the table above until they moved (step 3): the kit's client has none of them to import.
     Two helpers they import are in neither list, `sync/progress.ts` and `store/emitter.ts`, and the fence below says where they go.
     This part is cut.
- **The forks' fixes come back first**, so that the kit starts with every fix any of the three has.
  Every fix either fork made to a shared layer was this repository's already: memoriam's checks of the root in the contract suite are #497 and #511, ported to it, and skysa-draw's changes were the seams above.
  What they had that this lacked was tests, and four of their cases are mutations no test here caught: a file the format refuses, met by the pull's and the push's reads of a file as a document, and the hidden paths an engine syncs, asked of a deletion and of a scan's count.
  They are here now, in core's `engine/document.test.ts` and `engine/hiddenFolders.test.ts`, with two that state a rule the suite held only in passing: a pull writes nothing into a file whose id it invents, and every migration holds one statement between breakpoints.
  This part is done.
- **A lint rule fenced what was to move** from what stayed, and once it passed the move could be made.
  It was `kit/fence` in `eslint.config.js`, over `KIT`, which was the table above in code; both went in step 3 with the last of what they fenced.
  A module bound for one package imported only what went to it or to a package it uses: protocol is beneath storage, storage beneath sync and the server, and sync beneath the client.
  What it took from `@skysa/core` it took by name, and the module each name came from was held to the same.
  The deny-lists each seam added stayed beside it, since they said why a thing is handed in rather than imported, and went with the code they guarded.
  It is cut in four parts: the first two a pull request each, the third one for each of its steps, and the fourth, which the kit's own tests found, one.
  1. The source.
     Six imports crossed it, and each moved to where it goes: `PROVIDER_KINDS` to `providerKinds.ts`, `HIDDEN_PREFIX` to `paths.ts`, `concatBytes` to `bytes.ts` (where skysa-draw keeps it), and `contentTypeOf` to `files/mediaTypes.ts`.
     The two helpers the client imported, which all three apps have, join it: `sync/progress.ts`, once its one sentence went to the status's other words, and `store/emitter.ts`.
     `names/notes.ts` and `names/slug.ts` stay with the app, since they name notes and nothing that moves imports them; so `slug.ts`'s byte cap, which leaves room for `.md`, is each app's own, and skysa-draw's leaves room for `.svg`.
     This part is cut.
  2. The tests that go with the kit.
     The engine's and the adapters' own, and the sync kit they run in, handed notes' format, its folder and its hidden paths, and run on the kit's own now.
     `TEST_FORMAT`, in `tests/support/testFormat.ts`, is the partner of the fake's `TEST_FOLDER`: markdown claiming an id on an `id:` line of a leading block, read by a line rather than by notes' parser.
     Every engine test passed on it as they stood, so none of them was about notes' format, which notes tests for itself.
     The sync kit hands the engine no hidden-path rules unless a test does, so notes' four hidden folders are a test of notes' own (`tests/appFolder.sync.test.ts`), and the Drive stub holds whatever folder it is told.
     Four of Drive's cases ran the engine, which storage does not use, so they went to the engine's tests (`sync/overDrive.test.ts`); the two conflict-name cases that hang on notes' slug went to `names/slug.test.ts`.
     What notes keeps of its own is pinned by notes: `folderSpec.test.ts` holds a marker as 1.0 wrote it, byte for byte, which this app reads and writes the same, since the marker's code moves.
     `KIT` names each package's tests beside its source, and the fence reads `@skysa/core/testing` by name as it reads `@skysa/core`.
     This part is cut.
  3. The client's tests over this app's database, and what the build is handed.
     The scheduler's and the token source's tests ran over notes' Dexie database, and one of the relay's describes did.
     Each follows as a suite over a device (`tests/client/device.ts`), as core's store contract is a suite over a store.
     A device is the ports the client is handed and what a test does to the device around them.
     The kit runs each suite over in-memory ports of its own (`tests/client/memoryDevice.ts`), and notes runs the same suite over its database through `sync/dexiePorts.ts` (`tests/support/dexieDevice.ts`), so there is one copy of each test and neither side loses one.
     Notes' own wiring stays notes' test: the files beside notes, the clipboard and the key file (`scheduler.sources.test.ts`, and the companions in `scheduler.test.ts`).
     It is cut in steps.
     1. The token source and the relay.
        The device holds credentials and a kept token, and its in-memory token states keep a token on a synced connection only, as `tokenStatesOf` does.
        The token source's cases are `describeTokenSource` (`tests/client/tokenSource.ts`), run over memory in `tokens.test.ts` and over notes' database in `tokens.dexie.test.ts`.
        The relay reads only a credential, so its tests take the memory device's and move whole.
        This step is cut.
     2. The scheduler's port: an in-memory `ClientStore` over core's memory store, and a contract for the port, run over it and over `clientStoreOf`.
        The device carries the port (`store`), whose credentials and token states the token source and the relay take, and grows `show` and `queue`.
        The contract is `describeClientStore` (`tests/client/clientStore.ts`), run over memory in `clientStore.test.ts` and over notes' database in `clientStore.dexie.test.ts`.
        Core's memory store gives every op its attempts back and forgets its cursor, as the port asks, and is exported from `@skysa/core/testing`.
        The rule for an op out of attempts, `outOfAttempts`, was notes' and follows the engine's exception for an `rmdir`, so it is the engine's now, in `sync/attempts.ts`: the memory port and notes read the one statement of it.
        This step is cut.
     3. The scheduler's tests, a few files at a time, with the device growing as each needs it.
        The device makes the scheduler as its app does (`schedule`): the kit's over the ports in memory, with its own format and no hidden path synced, and notes' as `createNotesSync` makes it, with its companions attached, so notes' run covers what it covered.
        Its documents are made, changed and queued by the app's rule (`create`, `edit`, `queued`), and the harness that is not notes' moved to `tests/client/schedulerHarness.ts`.
        It is four pull requests: `scheduler.test.ts` and `scheduler.timing.test.ts`; pausing and the relay; the connection; the failures.
        `scheduler.sources.test.ts` stays notes': it is the companions.
        The first is cut: `describeScheduling` and `describePushTiming`, run over memory in `scheduler.test.ts` and `scheduler.timing.test.ts` and over notes' database in their `.dexie.test.ts` partners, with the scratchpad's case, which is notes' hidden-path rule, left in notes' own.
        The second is cut: `describePausing` and `describeChangeRelay`, run over memory in `scheduler.pausing.test.ts` and `scheduler.relay.test.ts` and over notes' database in their `.dexie.test.ts` partners.
        For them the device can be held up by another tab (`holdUp`), and the port's contract says what it waits on until the tab lets go.
        Left in notes' own are the three cases that only IndexedDB can show, of which transactions hold up which, and the relay's case about a paste, which is notes' clipboard.
        The third is cut: `describeConnection`, run over memory in `scheduler.connection.test.ts` and over notes' database in its `.dexie.test.ts` partner.
        For it the device resumes a source a detach kept, to be checked first where any of it names a file, and imports one it has never held, as the app binds; it can be reconnected in one step, as another tab does it (`reconnect`).
        The memory device's check is only what the scheduler meets of the app's: a file read, a failure thrown, and a binding meanwhile overtaking it; copying a source whose files are gone is the app's, and tested with its store.
        Left in notes' own is the import's case about the pile, which is the device's own notes, carried into the source.
        The fourth is cut: `describeFailures`, run over memory in `scheduler.failures.test.ts` and over notes' database in its `.dexie.test.ts` partner.
        What the device keeps is read through the engine's store, and a file can be added beside a document, its upload queued as the app queues one (`attach`).
        Left in notes' own are its eight tries, the account's name on its row, a row of a kind from a later version (#447), and a transaction of its database failing.
        This step is cut.
     4. The build's seam.
        `pwa.ts` carried notes' share target (`receiveShare`, and `share_target` in the manifest), which is this app's clipboard's, and its fallback assumed notes' one route.
        An app hands both in (`PwaApp`): the navigations its shell answers, and its share target if it has one, with the worker's rule for it whole, since Workbox writes the rule's function into `sw.js` as its source.
        Notes' are `pwaApp.ts`, and the built manifest and service worker are byte for byte what they were.
        The build's own checklist (`pwa.test.ts`) runs over an app of its own, and notes' route and share target are checked in `pwa.app.test.ts`.
        This step is cut.
     5. The build's default brand and its budget.
        Without a brand named, `brand.ts` read notes' "Notes" in gray from beside itself, and the bundle budget held notes' figures and its two pages and read the build from beside itself; skysa-draw's copies differ in exactly those.
        An app hands both in: the brand file it builds with when a deployment names none (`DEFAULT_BRAND` in `pwaApp.ts`), and its budget, which `scripts/bundleBudget.mjs` measures a build against (`checkBudget`, called by `scripts/size.mjs`).
        A brand file's JSON Schema describes the build's format, so it is the build's, beside `brand.ts`.
        The build's tests run over a fixture brand with icons of its own, and that the default is "Notes" is checked in `brand.app.test.ts` and `pwa.app.test.ts`.
        The build is byte for byte what it was, and `pnpm size` says what it said.
        This step is cut.
     This part is cut.
  4. The Worker's answer while its configuration is wrong.
     The kit's own tests found it, run in its repository for the first time: every code in the API's list is answered somewhere in the server's source, and `server_misconfigured` was answered only in `src/worker.ts`, which stays the deployment's.
     Every entry needs that answer, and the gate's comment said an operator's own entry would copy it, so it is the server's: `misconfigured` in `src/http.ts`, exported beside `createApp`, which logs every line of what is wrong (`logMisconfiguration`) and answers a generic 500.
     Notes' entry answers with it, and `worker.misconfigured.test.ts`, which stays with the entry, covers that path, which no test did.
     This part is cut.

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
   This step is done (2026-11-11).
   [`skysa-org/skysa-kit`](https://github.com/skysa-org/skysa-kit) holds the seven packages with their history, its own CI, the CLA (which covers it, confirmed 2026-11-10, and is signed there on a list of its own), its own `ARCHITECTURE.md` and the wiring for its releases.
   It was made public once the maintainer had looked it over.
   Its release workflow tags a version and then publishes it from that tag, as its `.changeset/README.md` says.
   0.1.0 is on npm (2026-11-11), all seven packages, with provenance.
   Its comments and documents are in American English, as skysa-draw's are, and its docs test holds them to it; a file ported from here before step 3 is respelled on the way.
3. This app depends on it and deletes what moved.
   This step is done (2026-11-12).
   The move is made (2026-11-11), a pull request a layer, each with its tests, its documents and its changeset: the server (#714); the protocol, storage and the engine (#715); the client (#716); the build (#717); the lint and the compiler's settings (#718); and this record (#719).
   249 of the 1,172 files under `apps/` and `packages/` went.
   Every test this app ran before still runs, here or in the kit at 0.1.0, by file and title, but for two that stronger ones replaced: the fill window's check of what it loads, and the default brand's of its schema.
   The built manifest is byte for byte what it was, and the bundle is within its budget.
   Every kit package is pinned at one version, exactly, and `apps/web/tests/kitVersion.test.ts` holds the manifests to it.
   `@skysa/api` keeps exporting `createApp`, `parseEnv`, `AppConfig`, `envWarnings`, `misconfigured` and `@skysa/api/relay`, and `@skysa/core` the seams' types and values, `PROVIDER_KINDS` and `MAX_CONNECT_CODE`, so a deployment's own policy builds unchanged.
   What an operator changes: a Worker entry of their own imports from `@skysa/api`, not from the files beside `worker.ts`, and a `wrangler.toml` of their own points `migrations_dir` at the kit's (`node_modules/@skysa/server/migrations`).
   #118, which is breaking, ships in the same major, 3.0.0, so an operator acts once (decided 2026-11-11): the kit's server stops reading `AUTH_MODE` and drops the tables a sign-in would have used, in its next minor version, and this app takes that version before the release.
   Before that release: the bundle against its budget (`pnpm size`), since tree-shaking now crosses a package's edge; the live provider suites; and a check on staging.
   The kit is 1.0.0 once this reaches production.
   3.0.0 reached production on 2026-11-12, and the kit was 1.0.0 the same day (skysa-kit#12 and skysa-kit#13), with nothing changed from 0.2.0 but what its version promises; this app pins it.
4. skysa-draw depends on it, and its record 0002 is superseded.
5. Memoriam depends on it, and has the entitlement seam, the gate, connect codes and the relay back without porting them.

Later, where two apps show the shape: frontmatter (this app and memoriam), a device's sources as silos (this app and skysa-draw), the catalog's machinery, and the gate's logic without its screens.

**For whoever hosts more than one of these apps.**
One Worker and one origin per app: the Content-Security-Policy, the device's credential and its IndexedDB each belong to an origin, by design (§6, "Per-connection credentials").
Each app is registered with each provider on its own.
Google revokes per Cloud project, so a project shared by two apps would let disconnecting one take away the other's access, and Dropbox and OneDrive name the app folder after the registration.
Where anything is keyed on a storage account, the descriptor's account-id rule says whether the same account can arrive from two apps under one id.

**Open, and decided when its step comes.**
- Whether skysa-draw's and memoriam's D1 databases are reset onto the kit's migrations (steps 4 and 5): their `0000_init.sql` has this repository's file name and not its contents.
