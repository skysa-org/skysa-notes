# @skysa/core

## 0.21.1

### Patch Changes

- 7c4541b: On a phone, or in any window too narrow for three columns, the notebook dropdown now shows the notebook's full path, as the heading over the notes does, instead of its name alone. When the bar is short of room the path is shortened in the middle: the notebooks it is in give way first (`Work/Proj…/Q3`), and the notebook's own name last.

## 0.21.0

No changes in this release.

## 0.20.3

No changes in this release.

## 0.20.2

No changes in this release.

## 0.20.1

### Patch Changes

- 3eaa0b5: On Google Drive and OneDrive, a clipboard item removed on another device no longer stays on the device that added it. That device used to keep showing it until the clipboard changed again or the app was reopened, while every other device let it go.

## 0.20.0

No changes in this release.

## 0.19.0

### Minor Changes

- 1fe2319: A clipboard a source's devices share. "Show clipboard" in a connected source's storage menu (the gear, or the source's `⋯` on a phone) puts a Clipboard region above the status line, on this device. Paste reads text or a picture from the system clipboard. A keyboard paste or a drop on the region, or "Add a file", adds files of up to 25 MB. Each item shows as a text preview, a thumbnail or a file card. Pressing one copies text or a picture back to the clipboard and saves a file. It keeps the last 10 items, newest first, and pasting something already there moves it to the top. Items are files in a hidden `.clipboard` folder in the app folder. A paste is kept on the device at once and sent when online, and where the instance runs the change relay, the source's other devices show it within a second or two. Not offered for notes kept on this device only. Turning it off only hides it, and disconnecting a source drops its clipboard from the device.
  
  `@skysa/core` exports the clipboard's naming (`clipName`, `readClipName`, `clipStamp`, `clipPath`, `isClipPath`) and its folder and cap (`CLIPBOARD_FOLDER`, `CLIPBOARD_ITEMS`). A sync's outcome now says when a pull met that folder (`SyncOutcome.clipboard`).

## 0.18.2

No changes in this release.

## 0.18.1

No changes in this release.

## 0.18.0

### Minor Changes

- d555ebc: On an instance that runs the change relay, the app holds a socket to it for the source on screen, while the app is in front of the user and online. A device that has just pushed says so, and the connection's other devices sync within a second or two instead of at their next poll. Polling goes on as before, and an instance without a relay is never asked for a ticket: the app asks `/api/config` first. The socket closes when the tab is hidden, goes offline, switches source or is disconnected. It reconnects with backoff after a failure, at once when its hour is up, and never after the device has been signed out.
  
  `@skysa/core` now exports the relay's wire protocol, so the two ends cannot drift: its two messages, its keep-alive, its close codes and its throttle.

## 0.17.1

### Patch Changes

- bca2080: A long sync on a phone no longer starts over when the screen goes off. A pull that fails part-way, as one does when a phone's screen times out and takes the network with it, keeps the notes it had already read, and the next try reads only the rest; before, a batch of up to a thousand notes on Google Drive was downloaded again from the first. While a sync long enough to show a count is running and the app is on screen, the app also asks the browser to keep the screen on, and lets go when the sync ends.

## 0.17.0

### Minor Changes

- 62ce687: A sync to Google Drive sends up to four notes at once rather than one at a time, so a large import reaches it several times faster. A provider says how many it takes (`StorageProvider.writesAtOnce`); Dropbox and OneDrive still take one, since Dropbox refuses writes that meet one another as a rate limit. Notebooks, moves, deletions, files beside notes, and the write of a note with a rename queued still go one at a time, in order, and a notebook missing under notes sent together is made once between them. Requests that find the access token expired at the same moment now share one new token.
- 6fbffb5: A long sync now says how far it has got. The engine counts a round from a stored cursor as it receives it (`SyncProgress` gains a `receiving` stage), so a device picking up another's import of a thousand notes is no longer silent until all of it lands. The storage panel shows a run of twenty or more as a count in its status line — "Sending 120 of 1,000", "Receiving 5 of 30", "Looking for notes: 40 found" — with a bar under it and the file it is on in the line's tooltip; in a compact window the panel says it in a sentence over the bar.

## 0.16.0

### Minor Changes

- 6d1123f: A note's dates come from its frontmatter in every browser. A `created` written as `2014-02-20 14:00:10 UTC`, as OneNote's exporters write it, is now read in Safari and on iPhones too, where it was taken for the day the note was imported. The date a note shows as edited is read from `updated`, or else from `modified`, `date modified` or `lastmod`, as other tools write it, or else from when the note was made, rather than being the day it was imported. Notes already imported keep the dates they were given; importing them again dates them by their frontmatter.

## 0.15.0

### Minor Changes

- 07032bf: Notes can be imported from a folder or from files (a `.zip`, such as the one "Download all notes" makes, or loose `.md` files), from the storage panel of the source showing. Notebooks and the files beside notes come too. Before anything is written, a question says what will come in and what stays out and why: notes that are not UTF-8 text, notes the app keeps hidden, and files over 25 MB. Nothing already in the source is changed: a taken name gets a number, and a file already there is not sent again. This is the way to bring notes into a Google Drive source, where files copied into the folder on the Drive website are invisible to the app; the Drive notice now points to it.

## 0.14.0

### Minor Changes

- 51f4ba2: An operator's `checkCode` may answer an accepted code with `hold`, a value the app keeps and sends in place of what was typed, for up to a year: a pass for the device, say, so a code good for minutes is typed once per device rather than once per sitting. The app never shows a held value (the gate says the code was accepted on this device, and Change opens an empty field), and asks about a held value again as it loads, at most once an hour and at once after a refused connect, keeping the answer and letting go of a value the policy refuses. A refused connect no longer drops a held value, only a typed code. An app from before this release refuses an answer that keeps a code longer than a day, so an operator should give long holds only once its app has been updated. A code, or a held value, may now be up to 256 characters. The self-hosting guide's code gate example gains the `checkCode` it needs.

## 0.13.0

No changes in this release.

## 0.12.0

No changes in this release.

## 0.11.1

### Patch Changes

- 8f50a08: When the rich editor keeps a note in markdown mode, the banner now always says what it found. If the editor would add something the note doesn't have, the banner says so and shows what it is, including its text, with invisible characters written out. A kind of markdown the banner has no friendly name for is named as it is, rather than as "markdown the rich editor has no way to show".

## 0.11.0

### Minor Changes

- fdeb4c9: The sync engine mirrors files that are not notes on pull (#187). Each listed file becomes a row, matched by id, or adopted from a pending row at its path of the same size; nothing is downloaded. The remote keeps the path: a pending row, or one the user moved there, steps aside under a conflict name that keeps its extension. A file the user is deleting is passed over, and one the user is moving stays where they put it. A file deleted there goes, unless the user moved it here, when it is pending again and sent from the bytes held here, or let go of at the push where none are; a file moved to a hidden path counts as deleted. Folder deletions take bound rows and keep pending ones, a note renamed into a file lets the note go and the other way round, and a scan drops the bound rows it did not find. In the web store, a file sent again is pending whether or not its bytes are held here, as the engine expects.
- fe51fa7: The sync engine pushes files that are not notes (#187). An `upload` sends a pending file's bytes, or copies them from the remote file it copies, making the folders it needs. The same file already at its name is taken for its own, unless another row holds it or a queued delete is to take it. Anything else there keeps the name, and the upload goes beside it under a conflict name that keeps its extension, chosen from one listing of the folder. A `move-file` moves a file by id, and a `delete-file` deletes one. Uploads do not hold up the queue: one that fails is counted and stepped over, then sent after everything else on later pushes; one out of attempts is kept and reported; and the outcome carries `waitingUploads`. A delete that a waiting copy still needs is held back, and so are an `rmdir` over it and an upload or move to its name. An `rmdir` leaves a notebook that still holds a file row. The web store no longer carries cached bytes to a file a move took for its own. New exports: `contentTypeOf` and `conflictFilePath`.
- c74a4f3: Every storage adapter can now upload and download a file's bytes exactly as they are, not only a note's text: `readBytes` and a create-only `createFile` join the provider port, with Google Drive switching to a resumable upload above 5 MB. Nothing in the app calls them yet; they are the ground attachments are built on (#187). A file's `size` is now documented as bytes on every file entry, a conflict's included.
- 38df50c: The sync store learns files that are not notes (#187): a row per file, bound to the remote or pending upload, with its bytes kept apart and handed back only while they are still the file's. `SyncStore` gains `fileById`, `fileByPath`, `fileByRemoteId`, `allFiles`, `filesUnder` and `fileBytes`; a pull can put, move aside, delete and re-upload a file; a folder move and delete take files with them, leaving a pending one; and an upload, a file move and a lost file each have an outcome. The web app's database gains `files` and `fileBytes` tables.

### Patch Changes

- 7f97971: Helpers for attachments (#187), not yet used by the app: the content-stamped name a file is stored under beside its note, the markdown that links it, which links name a file and where it is, every file a note links, and what kind of file a name is, including which few types may ever be opened in a tab, and that an SVG is drawn from a `data:` URL.
- 4697951: On Google Drive, two files of the same name in one folder are no longer separated by renaming the second to a note: a picture named `photo.png` became `photo.png (conflict …).md`, which the app would then try to read as text. A file that is not a note keeps its own extension in its conflict name (`photo (conflict …).png`), and a second copy with the same bytes goes to the trash instead of being kept beside the first. Notes are renamed as before. Nothing the app writes today is affected; it clears the way for attachments (#187).
- cca1e62: A picture pasted, dropped or picked into a paragraph with words in it now goes in a paragraph of its own, rather than on the line beside them. A note's preview no longer runs a picture's or a file's name into the word before it.
- 1332b16: The library learns files beside notes (#187). `addAttachment` adds a file to a note's folder under a content-stamped name, refusing anything over 25 MB and any `.md`, and queues its upload ahead of the note. Moving a note takes the files it links with it, copying one another note in the old notebook still links, and putting one beside a different file of the same name under a conflict name; moving a notebook moves its files ahead of its notes, and deleting one deletes them, with the count in the confirmation. A file not uploaded yet counts as unsent work when a source is disconnected, keeps its upload while the source is detached, and is forgotten with a source the user discards. A blocked sync names the op that stopped the queue rather than an upload stepped over. In the sync store, an upload that lands for a file moved or deleted meanwhile sends the `rmdir`s over it behind what it now owes, so a notebook let go during an upload does not stay on the remote. Nothing in the editor adds a file yet.

## 0.10.0

No changes in this release.

## 0.9.0

No changes in this release.

## 0.8.0

No changes in this release.

## 0.7.0

No changes in this release.

## 0.6.3

No changes in this release.

## 0.6.2

No changes in this release.

## 0.6.1

### Patch Changes

- 4d583cb: A note's preview in the list, and its excerpt in search answers, are the text
  the rich editor shows — `**bold**` reads "bold", a link reads as its words
  without its URL — rather than the markdown with only its line markers removed.
  In the list, a pipe stands where one line of the note ends and the next
  begins, so two lines no longer read as one sentence.

## 0.6.0

No changes in this release.

## 0.5.2

No changes in this release.

## 0.5.1

No changes in this release.

## 0.5.0

### Minor Changes

- 8d9c55c: A connect gate's code is checked as it is used. **Breaking** for a gate with
  `connectCode`: `createApp` now refuses one whose `EntitlementProvider` has no
  `checkCode(code)`, which answers `{ accepted: true, expiresIn }` in seconds (at
  most a day) or `{ accepted: false, reason? }`. The app asks it through the new
  `POST /api/connect-code`, which is same-origin and rate-limited as
  `connect-code:<ip>`, and the callback still decides with `check`.
  
  `connectCode` takes `required`, which leaves no way to the buttons without an
  accepted code. The gate is two steps, one open at a time. An accepted code is
  held in `localStorage` for as long as the policy said, and the gate folds to a
  line naming it until it runs out. A refusal is shown under the field, in the
  policy's words where it gave some.

## 0.4.1

No changes in this release.

## 0.4.0

### Minor Changes

- fddbb56: An operator's gate can ask for a code. `ConnectGate` takes an optional
  `connectCode: { label }`, and the app shows a field under that label where the
  gate is, in front of the provider buttons and beside them. What is typed is
  held for the tab, sent with `/start` as `connectCode` (trimmed, at most
  `MAX_CONNECT_CODE` characters), carried to the callback in the signed flow
  cookie, and handed to the policy there as `check(subject, { connectCode })`.
  `/token` never passes it. A plain refusal of a connect that carried a code reads
  "The code you entered was not accepted", and the code is dropped.

## 0.3.0

### Minor Changes

- 8176135: An operator can gate connecting. `EntitlementProvider` takes an optional
  `gate` — a message and one `https:` link — which `createApp` checks when it is
  built and `/api/config` serves as `connectGate`. The app shows it where the
  provider buttons are: a device with an account syncing on the instance sees the
  buttons with the gate beside them, and any other sees the gate with an "Already
  have access? Connect storage" control that shows them.
  
  A refusal can say which kind it was: `EntitlementDecision.code` is one of
  `ENTITLEMENT_CODES` (`not_allowed`, `lapsed`, `limit_reached`), carried by the
  callback as `?connect=refused&code=…` and by `/token` beside `reason`; any other
  value is dropped. The refused toast and the storage panel word the refusal by
  it, the panel shows the operator's reason, and both offer the gate's link.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- c228479: An operator's `EntitlementProvider` is asked at the OAuth callback as well as at
  `/api/token`, before anything is stored. An account it refuses no longer leaves
  a refresh token sealed in the database: nothing is stored, the consent just
  given is withdrawn where the provider has a call for it, and the app says the
  account cannot sync on this server. For operators: `EntitlementSubject`'s
  `connectionId` is now optional, and is absent when the account is connecting
  for the first time.
- 480405f: A source's first import says how it is going — notes found, then downloaded and uploaded against the whole count, with the file it is on — and can be cancelled, which puts the device back as it was before connecting. For the first source connected, the app is held behind the progress dialog until the import is through. The sync engine takes an `onProgress` option, and a full scan now lists every page before it downloads a note, so it has the whole count first. The web app cancels a sync session's requests when the session ends.
  
  The page and the installed app are called Skysa Notes. The storage panel's Re-scan and Disconnect are outlined buttons, Disconnect in red. The outline's toggle sits beside the note's menu, and on a phone the outline flies out over the note and shuts once a heading is chosen.
- 8bb745f: Notes are keyed by connection and id, so two connected sources can each hold a
  note of the same id — which they do whenever one folder has been copied into
  two accounts, since the id travels in the file.
  
  The local database moves to schema version 5 on first open. Every note is
  carried over as it was; the upgrade is a single transaction, so a failure
  leaves the database as it found it. A tab still running the previous build is
  stopped and asks to be reloaded.
  
  A file whose id another source already holds now syncs under the id it names.
  It used to be given a made-up id, and the two sources then took turns writing
  their own id into the file.
  
  `SyncStore.idHeldElsewhere` is removed from the core port: a store's ids are
  its connection's own, and the engine no longer asks. When two sources that
  held a note of one id are both disconnected, the second to arrive in the local
  pile is given a fresh id and keeps its queue.

### Patch Changes

- 751d856: The provider contract suite no longer assumes a change feed is immediate and
  reports each thing once. Google Drive's is neither: measured against a live
  account, a new file took 1.4–2.8s to reach `changes.list` and one creation was
  reported twice about two seconds apart with the same version.
  
  Three additions, all test-only. `changesLagMs` says how far behind a feed may
  run, and is 0 for every stub and for Dropbox and Graph. `drainUntil` polls the
  feed until what the caller is waiting for appears, which is sound for an
  expectation that something turns up and is what a fixed wait cannot do
  reliably. `quietCursor` drains until a round comes back empty before taking a
  baseline, which is what a feed that echoes needs and what polling cannot give
  an assertion about emptiness. The live Drive harness also waits for its own
  deletions to leave the search index, so the next scenario's cold-start scan
  does not find files whose parent it has already removed.
  
  No adapter changed. Unlike the Dropbox and OneDrive live runs, Drive's failures
  were all the suite's assumptions rather than the adapter's behaviour.
- 74e5bc6: A folder created on Dropbox is reported as a folder. `create_folder_v2` answers
  with a bare `FolderMetadata`, which — alone among the endpoints the adapter
  reads entries from — carries no `.tag`, so the shared mapper called every folder
  the app made a file. Nothing downstream read that field, so no stored data was
  wrong, but the adapter was not honouring `StorageProvider`.
  
  Found by running the contract suite against a real Dropbox account, which also
  showed why no offline test could have caught it: the wire stub had been tagging
  the response Dropbox leaves untagged. The stub now answers as Dropbox does.
  
  Two scenarios in the suite turn out never to have tested what they claim,
  because both made a version up. Dropbox validates the shape of a `rev` before
  comparing it, and — the part that matters — an `update` carrying a rev it has
  never issued has nothing to conflict against, so against a missing path it
  quietly creates the file. The conflict scenario now takes a per-provider
  `staleVersion`, and the missing-file scenario seeds a file, deletes it, and
  writes with the version that file really had, which is the only way the engine
  ever reaches that path.
- 30a5c70: Saving a note no longer respells frontmatter the app did not change. Writing
  any one key used to re-serialise the whole block, so `zip: 02134` came back as
  `2134`, `0x1F` as `31`, a twenty-digit integer short of its last digits, and a
  `created: 2024-09-14` the user wrote as a full timestamp; list layout and
  spacing went the same way.
  
  Only the keys whose value actually changes are rewritten now, and everything
  else keeps the characters the file had — comments, quoting, key order and the
  blank lines between keys included. `writeFrontmatter` hands back the YAML it
  was given, byte for byte, when the patch changes nothing. `updated` is still
  rewritten on a save, because the app does change it.
  
  A `created` the app cannot read as a date (`created: last spring`) is left as
  written, rather than being replaced by the time the file was first imported.
  
  A comment under a key with no value (`tags:` as a template leaves it) stays
  where it was when that key is filled in or removed, and a comment on the line
  of a tag list survives new tags. A value that another line reads through a
  YAML anchor (`title: &t a`) is not written over, and a block `yaml` cannot
  evaluate is handed back unchanged instead of throwing.
- ba48ecc: A `<br />` inside a sentence no longer sends the note to markdown mode. The
  rich editor was deleting it — `first<br />second` became `firstsecond` — and
  the check that protects notes from the editor caught that and locked the note
  in markdown mode with a banner. Now only the `<br />` the editor itself writes
  for an empty paragraph is read back as one; a break the author wrote, in any
  spelling and anywhere in the note, stays exactly as written.
  
  A `<br />` on a line of its own inside a paragraph works too. When the note is
  next edited in the rich editor, the line ending just before it becomes a
  space — the markdown writer does that to any inline HTML at the start of a
  line, so it cannot be mistaken for an HTML block — which reads and renders the
  same.
- 15f05a4: Renaming a note on one device while another device edits it could lose that
  edit, or leave the renaming device showing the old text. After moving a file the
  engine kept the version the provider handed back, which is the version of bytes
  it had never read: a pull then skipped the file as already seen, and a write
  queued in front of the rename was checked against the other device's edit,
  passed, and overwrote it with no conflict copy. Every provider was affected.
  The engine now keeps a version after a move only over bytes it knows — reading
  the file where it has to, which on OneDrive is every rename — and otherwise goes
  on holding the one it had, so the next pull reads the file and an edit on both
  sides is kept as a conflict. Found by the two-browser soak test, seeds 578 and
  461.
- 470c58e: The OneDrive wire stub no longer puts a `name` on a deleted item. Graph sends
  none — verified against a live personal account, which is the case the stub's
  `businessDeletes` option implied was different and is not. A deletion arrives
  as its id, its `parentReference`, the `deleted` facet and a file/folder facet,
  and nothing else.
  
  Nothing depended on it: the adapter resolves a deletion by id through its
  cursor tree and never reads the name. The option is gone, and the test that
  used it now describes the ordinary case rather than a Business one. Test
  helpers only — no behaviour change.
- ceb0e5f: Folders can be created on OneDrive at all. The adapter addressed a new
  folder's parent by path, and Graph answers a `POST .../children` whose parent
  is addressed that way with a bare `400 invalidRequest` — at every depth,
  including the app folder itself, whatever the name and `conflictBehavior` say.
  The parent now goes in by id, which Graph accepts.
  
  Nothing about this was visible offline: the wire stub accepted the path form,
  so the whole contract suite passed against an adapter that could not make a
  single folder on a real account. The stub now refuses it as Graph does, and
  fails the eight scenarios the live account failed.
  
  The blast radius was everything with a folder in it — `mkdir`, and so the
  first notebook a device syncs, and every move, delete and scan that needed
  one. Reads were unaffected (`GET .../children` by path is fine) and so were
  files (`PUT approot:/{path}:/content`), which is why an app folder could end
  up holding its marker file and nothing else while sync retried and blocked.
- 1fdbf29: A note that reads everything again no longer leaves a ghost behind. When a
  re-scan found somebody else's file arriving at one of your notes' names, the
  note was moved aside to a conflict name — and then spared the check that asks
  which notes the provider no longer has, because the batch had "decided" about
  it. Moving a note out of the way says nothing about the file that note holds,
  so a note whose own file had been deleted kept its row and showed up as a
  conflict copy of a note that never conflicted, until some later re-scan
  happened to clear it. Now the displacement counts for nothing there: the note
  is kept only if its own file was among what the scan returned. With unsent
  edits it is kept and cut loose, as always. A re-scan the provider warns may be
  missing things still removes nothing at all — and still leaves a moved-aside
  note alone rather than sending it up, which at its new name would make a second
  file rather than meeting the first.
  
  A push that has to step around another device's file also names the copy
  better. The name was picked from this device alone, so a name already taken on
  the remote — by another device setting its own edit aside in the same minute —
  cost the push an attempt and could leave the note called
  `plan (conflict …) (conflict …).md`. The remote is now asked for the name
  before the note is moved: by the write itself where the note's edit is going up
  as a new file, and by a read per candidate where the note has a file of its own
  to stay with and nothing to write.
- c2a0296: Fixes from a whole-codebase review. Nothing here changes the file format or the
  database schema.
  
  Sync. A note no longer ends up at a path its file has left when a round renames
  its folder away and moves the file back to the old name — the pull said `ok`
  and the next edit blocked the queue. A second connected source whose files name
  note ids another source on the device already holds now syncs; it used to fail
  identically on every retry, for ever. A cycle in the id tree an OneDrive or
  Drive cursor carries — a legitimate state between two pages — no longer
  overflows the stack on a large library.
  
  Editor. A sync pull into a note open in rich mode no longer saves a conflict
  copy nobody typed: changes Milkdown's own plugins make in answer to a loaded
  body (heading ids, table repair) were being counted as the user's. Undo after a
  pull no longer puts the pre-pull text back and pushes it over someone else's
  edit; an adopted body empties the undo history in both editors.
  
  Deleting a note can be undone for about ten seconds, from a notice or the
  palette, whether or not the delete has already synced. The note goes back to
  the source it was deleted from, keeps its path, and anything that took the name
  meanwhile moves aside. Text the editor still held comes back with it — as the
  body, or beside the note where something newer had been stored since.
  
  Saving. A save that fails is said, in the note, and retried — newest text
  first, never an older body over a newer one — where it used to be dropped
  silently. A tab left open across a schema upgrade made by a newer
  build in another tab now finishes its writes, closes, and asks to be reloaded,
  rather than carrying on writing with old code into the migrated database. A
  tab that opens after the upgrade was made closes at once, writing nothing, and
  asks the same. The notice can be
  put aside to copy text out.
  
  Files. An `id:` the user wrote that the app cannot use (`id: 202409141302`) is
  left as written instead of being replaced by a UUID on first save, in the note
  and in a conflict copy of it, and is not respelled (`0123` stayed `0123`) when
  the title or tags are written. A frontmatter block closed by `...` is read as
  one, the same way before and after the app's own save (which fences the block
  with `---` where the body's first line would otherwise be taken for its closer), and an unclosed block no longer swallows prose up to the next `---`. File
  names are cut between grapheme clusters and capped at 216 bytes as well as 120
  code points, and a conflict copy's name is fitted to 255 bytes, so an emoji at the boundary cannot produce a name OneDrive's
  adapter throws on; existing files are not renamed.
  
  Shell. A crafted `?note=` link can no longer crash the app — search params a
  route refused were reaching components anyway — and a render error now shows a
  screen saying the notes are safe, with Reload and Try again. In the storage
  panel, "Stop syncing on this device" after a failed disconnect can no longer be
  pressed under a different source than the one that failed.
- 4ca6bad: A file in the notes folder that is not UTF-8 text — saved as Latin-1 or UTF-16
  by another tool, or a binary that happens to be named `.md` — is now left
  alone. It used to be decoded anyway, arriving as a note with `�` wherever a
  byte would not read, and the next push (even the app adding an `id`) wrote that
  damage over the original. Now nothing is imported and no note stays bound to such
  a file, so once a sync has seen it nothing the app sends can land on it. A note
  with no unsent edits
  whose file became unreadable goes from the device; one with edits keeps them,
  under a conflict name, and they go up as a new file beside the one that could
  not be read. A sync no longer stops on such a file, and reconnecting a folder
  whose notes have all been re-saved that way still recognises it. Save the file
  as UTF-8 and it is picked up on the next sync. Listing these files in the
  storage panel follows separately.
  
  Text holding a NUL character counts as unreadable too, since that is what UTF-16
  without a byte-order mark and most binaries look like. So the app never writes
  one: a NUL pasted into a note is dropped by the editor as it arrives, and again
  as the note is saved or a file is imported.
- 0b73ab7: The storage panel now says which files it is not showing. A file in the notes
  folder that is not UTF-8 text is left alone, and until now nothing said so: a
  note whose file another tool re-saved as Latin-1 simply went from the device.
  Each connected source now lists those files by path under its sync status, with
  what to do about it — save the file as UTF-8, or delete it — and the line goes
  once the file reads, is deleted, is renamed to something that is not a note, or
  a re-scan no longer finds it. A note of yours that had to move aside because
  such a file has its name is reported like any other conflict copy.
  
  The list is kept with each source's sync cursor and written in the same step, so
  it never names a file from a sync that did not finish, and "Re-scan from
  scratch" keeps it until the scan has looked. It is a notice only: nothing the
  app decides depends on it, and a file on it is still read again every time the
  provider mentions it.
  
  For anyone implementing `SyncStore`: there is one new read, `unreadable()`, and
  two new `PullChange` kinds, `unreadable` and `forget-unreadable`; `move-folder`
  carries the listed paths under a folder along and `delete-folder` drops them.
  The store contract suite covers all of it.
- 7d827cf: When a note has something the rich editor can't show, the banner now says what
  it is and which line it's on — "The rich editor has no way to show a link
  reference definition on line 5" — rather than only that there is something.
  
  And the note is no longer stuck in markdown mode for as long as it stays open.
  Once you have changed it, the rich text tab (and Ctrl/Cmd+E) is offered again;
  pressing it saves what you typed, then opens the rich editor, which checks the
  note again before you can type. If it still can't show the note, you are back
  in markdown mode with the banner saying what it found this time, and nothing
  in the note has been changed.
