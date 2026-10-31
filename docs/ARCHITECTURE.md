# skysa-notes — Architecture and decisions

Local-first markdown note-taking PWA that syncs to a dedicated, app-owned folder on the user's cloud storage (Google Drive, OneDrive, Dropbox).
WebDAV was planned too and is deferred indefinitely (§5.4).
Notes are plain `.md` files in a normal directory tree, so the user can open, edit, and back them up with any other tool.

This repo is the complete, self-hostable product: one Cloudflare Worker serving the SPA and a small API, plus the operator's own provider app registrations.
This document is the source of truth for the architecture, and with the records in [`decisions/`](decisions/README.md), for every decision behind it.
Update it when a decision changes.
It is not a to-do list: open work lives in GitHub issues.
The record of how the product was built is [`history.md`](history.md).

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
| Accounts | A device may hold several connected sources at once, each its own silo — its own notes, its own queue, its own credential — and shows one at a time (Phase 7) | Nothing aggregates them, on the server or off it |
| Sign-in | There is none, and there will not be one. Identity *is* the storage connection: a connection is reached by the credential the device that made it holds, and nothing on the server knows that two connections belong to one person | Decided 2026-09-18 (§6, "No sign-in separate from storage"). Auth and data are coupled on purpose; a separate account layer would put a subject on the server that every privacy claim here then has to be re-argued around |
| Distribution | One public repo that is the complete, self-hostable product. No operator-specific configuration or credentials in the tree | A clean clone must deploy end to end on a fresh Cloudflare account |
| License | AGPL-3.0 — version 3 only, SPDX `AGPL-3.0-only`, not "or any later version" — with a CLA for contributors; trademark on the name/logo held separately | Real open source; network copyleft keeps modified deployments open; CLA preserves relicensing options. See §13 |
| Provider enablement | `ENABLED_PROVIDERS` env selects which of `gdrive,onedrive,dropbox,webdav` an instance offers | Operators who disable WebDAV remove the only path where content transits the server and the only SSRF surface |
| Note content | The server never stores note content, only tokens and connection metadata. For OAuth providers content never transits the server at all; WebDAV content streams through the proxy and is never persisted | Core privacy promise |
| Token flow | Backend does Authorization Code + PKCE with every OAuth provider, stores refresh tokens encrypted, mints short-lived provider access tokens for the client; **client talks directly to provider APIs for file content** | Uniform auth across providers, no client secrets in bundle, no file bytes through our server (except WebDAV) |
| Offline | Full read/write offline against IndexedDB; sync queue drains when online | It's a PWA; sync is a background concern |
| Conflicts | Never lose data. On conflict, keep the remote version at the original path and write local as `<name> (conflict <YYYY-MM-DDTHH-mm>).md` | Simple, predictable, recoverable |
| Editor | Rich-text (WYSIWYG) by default, raw markdown mode as a toggle; **the markdown string is the only source of truth** — the rich editor is a view over it | Notes are files; the editor must never own state the file can't represent |

Rows above that mention WebDAV describe the deferred design (§5.4); nothing in the repo implements it.

Non-goals for v1: real-time collaboration, sharing, full-drive access, mobile-native wrappers, syntax beyond CommonMark + GFM (tables, task lists, strikethrough).
(Attachments were one until 2026-10-03: a file or a picture now goes beside the note that links it, §3 and §7, #187.)

---

## 2. Architecture overview

```
┌──────────────────────────── Browser (PWA) ────────────────────────────┐
│  UI (React)                                                            │
│   └─ Notes store (Dexie/IndexedDB) ── Sync engine ── Provider adapter  │
│                                              │                         │
│  Service worker (Workbox via vite-plugin-pwa): app-shell cache, bg sync │
└──────────┬───────────────────────────────────┼─────────────────────────┘
           │ sk1_ credential (bearer)          │ provider access token (bearer)
           ▼                                   ▼
┌── Backend (Hono on CF Workers) ──────┐   ┌── Provider APIs ──────────────┐
│  /api/auth/*      OAuth start/callback│   │  Google Drive v3 (CORS ok)    │
│  /api/connection  one silo's state   │   │  Microsoft Graph (CORS ok)    │
│  /api/token       mint access token  │   │  Dropbox v2 (CORS ok)         │
│  /api/webdav/*    proxy (CORS shim)  │──▶│  WebDAV server (via proxy)    │
│  D1: storage_connections, grants     │   └───────────────────────────────┘
└──────────────────────────────────────┘
```

Key property: the backend is only required for (a) connecting/refreshing an account and (b) WebDAV, which is deferred (§5.4).
Where an operator turns it on, it also (c) relays a content-free "something changed" between a connection's devices (§6, "Change relay"); without it, or with it down, devices find each other's changes by polling, as they always have.
Once a client holds a valid access token it syncs peer-to-provider.
If the backend is down, the app still works offline and can sync to OAuth providers until the access token expires.

---

## 3. Note format and directory layout

Remote root folder (app-owned), `skysa-notes/` (`APP_FOLDER_NAME`):

```
skysa-notes/
├── .notesapp.json            # marker file, see below
├── .encryption.json          # the source's public key for its vault, if set up (§7)
├── .clipboard/               # the clipboard a source's devices share (§7)
│   └── 20261006T153012123Z-pasted-image-3f9a1c2b.png
├── .scratchpad/              # the scratchpad's notes, shown as cards (§7)
│   └── untitled-2.md
├── .vault/                   # the vault's passwords, one note each (§7)
│   └── github.md
├── Inbox/
│   └── quick-thought.md
├── Work/
│   ├── 2026-q3-planning.md
│   ├── q3-report-3f9a1c2b.pdf  # an attachment, beside the note that links it
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

`createdBy` exists only for debugging (which install created this folder, with what version).
It contains no account identifiers.
`schemaVersion` gates future layout migrations; if a client sees a higher version than it understands, it opens read-only with a banner.

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
- Frontmatter is optional on read (files created by other tools are valid notes).
  The app adds it on first write.
- A note's times are read from its frontmatter where it gives them, and are the time the file was first read here where it does not (2026-10-05).
  When it was made: `created`, else Obsidian's `date created`.
  When it was last edited: `updated`, else `modified` (OneNote's exporters, Bear), `date modified` (Obsidian) or `lastmod` (Hugo), else when it was made — the note list shows the edited date, and a library exported from OneNote, which records `modified` on a fifth of its pages, showed the other four fifths as edited the day they were imported.
  Not `date`, which is as often when a post went out.
  A key whose value is no time is passed over for the next.
  Read again, a note's edited date only moves forward: the file's where it is later than the row's, the row's own where the file is the one the row has (a push's echo), and otherwise now — the file has changed and says nothing later, because another tool kept the old date or because its frontmatter is one the app cannot write into; taking the file's older date there put a note back years on every pull.
  The file's creation date is taken over the row's, so a row dated by its import on a device that could not read the file's spelling is put right on its next read.
  The app writes back only its own `created` and `updated`, and **never writes over a `created` the file has**, readable or not: when a note was made does not change, so a store holding another value for it holds a wrong one, and before this rule a Safari device wrote the import day over a 2014 `created` on the first edit and a Chromium device wrote 2014 back on its next.
  Only a `created` the file lacks, or names with nothing after it, is filled in.
  Another tool's keys stay as they are.
  Every time is read by one rule in `core` (`readTime`), not by `Date.parse`: engines disagree on all but the one form ECMAScript pins down, and the form exporters write most, `2014-02-20 14:00:10 UTC`, Chromium reads and WebKit — Safari, and every browser on an iPhone — answers `NaN` to.
  A date, then optionally a time after `T` or a space, then optionally `Z`, `UTC`, `GMT` or an offset, after a space or not; a date alone is midnight UTC and a time without a zone is local, as ECMAScript reads the ISO forms.
  A day the month does not have is no time (checked in UTC, so a local time a clock change skips is what the engine makes of it), nor is an offset past ±23:59.
  Any other spelling, and a date with an offset and no time, (`Feb 20, 2014`) is still handed to `Date.parse`, so nothing read before goes unread.
  The writer compares times by the same reader, so a spelling the store read is the spelling the file keeps, in every browser.
- Filename is a slug of the title; the app renames the file when the title changes, and only then — a name is never re-derived from a title that did not change, so a rule about names that is tightened later applies to the next rename and not to the files already there.
  A slug is at most 120 code points and at most 216 bytes of UTF-8, cut between grapheme clusters, and always well-formed UTF-16: a lone surrogate makes `encodeURIComponent` throw inside an adapter, which is a counted failure on an ordered queue. 216 is what lets a name the app chose take one conflict suffix whole inside the 255 bytes ext4 and APFS allow a name — where the provider's desktop client puts the folder — (28 for ` (conflict 2026-09-15T14-32)`, 3 for `.md`, 4 each for the two `-999` counters).
  It promises nothing past that: a copy of a copy, or a long name from another tool, is fitted where the conflict name is made, by cutting the end of the stem — never the suffix, the counter or the extension — and the name is checked against the folder as cut.
- `id` in frontmatter is the stable identity **when the app can use it**.
  An `id` the user wrote that the app cannot — YAML reads `id: 202409141302` as a number, and coercing it would collide `0123` with `123` — is declined and left exactly as written, a conflict copy included.
  That is held in one place, `writeFrontmatter`, which neither sets an `id` over it nor lets the YAML writer respell it (`0123` would come back as `123`) whatever else the patch changes: the note is then what a note with no `id` is, known to the device by an id the file never sees and matched by `remoteId` and path.
- A frontmatter block is closed by `---`, or by YAML's document-end marker `...` (pandoc writes it).
  `...` closes one only if the YAML above it parses without a single error, as a mapping, and names something metadata is named, because `...` is also an ellipsis and a clean parse is the evidence it was not one.
  Where both readings exist, `---` stands unless something other than blank lines lies between the `...` and it: YAML ended its document at `...`, so what follows was never metadata — it is a pandoc block and the top of the note run together as far as the note's first thematic break (a slide deck's `# Slide 1`, which YAML takes for a comment and raises no error over; a paragraph over a setext underline).
  The rule looks at the text and not at how well it parsed, so it answers the same before and after the app's own write, which may tidy blank lines away (it does for the rare block it has to stringify whole).
  A block the parser had to repair is kept, erring towards frontmatter — refusing one costs the note its `id`, and the next write then puts a second block above the first — unless a blank line in it is followed by a sentence: a line of more than one word with no `key:` in it (a key may hold spaces: Obsidian writes `date created:`) that is not a template tag.
  One word is a slip in real frontmatter (`url:http://…` with the space left out), not prose.
  Then the whole file is body, where the user can see it, rather than prose hidden from both editors and dropped from a conflict copy.
  That question is asked when a file is split and never of a block already stored.
  A block goes back into the file with the closer it had, with two exceptions that keep the rule above answering the same for the file the app writes as for the one it read: a body that opens with a `---` line would be read as the block's closer, or as prose run into it, so the block is written between `---` fences; and a block edited until it no longer names any metadata would stop being read as one at all, and gets them too.
  What goes back inside it is the text that was there, with only the keys whose value the app actually changed rewritten: being named in a patch is not a change (a save names every field the store holds), differing from what the file reads as is, and a time is compared as an instant — so `zip: 02134`, `0x1F`, a twenty-digit integer, a quoting style, a comment, a list's layout and `created: 2024-09-14` all keep the user's bytes, a patch that changes nothing returns its input, and `updated` is rewritten on a save because the app does change it.
  The changed pairs' lines are spliced into the original text rather than the document being stringified and repaired afterwards, since text never handed to the stringifier cannot be respelled by it.
  The splice is kept only if it means what the patched document means, not merely if it parses — under a scalar that keeps its trailing blank lines (`|+`), the blank line a deleted pair leaves behind parses as one more line of a key nobody touched — and otherwise the block is stringified whole, as every block once was.
  A key with no value (`tags:`, as a template leaves it) owns its own line and no more, though `yaml` hands it every comment down to the next key.
  A value carrying an anchor is not written over, since another line may read it through an alias, and the writer never throws: a block `yaml` cannot evaluate or write is handed back as it came.
  A seeded fuzz in the same test file holds all of this over blocks put together at random.
  A `created` the app could not read as a time (`created: last spring`) is declined as an `id` is: the store's fallback, the time of the import, is never written over it.
  An `id` given as an alias is read through it (`id: *other`), like any other the app declines.
  The fences are anchored on `\n`, `\r\n` and `\r` only; U+2028 and U+2029 are not line endings, and read as ones they split a block inside a quoted title.
  `tests/markdown/frontmatter.test.ts` carries the splitter this replaced and a table of inputs the two must agree on, with each intended difference named.
- **A block another editor flattened into a heading** (2026-10-14, #101).
  Google Docs is Drive's default handler for `.md`, and reads a block as CommonMark does: the opening fence is a rule, and the closing one makes the YAML a setext heading, which Docs writes back as `## id: … created: … updated: … title: …` — the lines joined by spaces — over the same file.
  A file with no block of its own whose first line is a `---` rule with an ATX heading under it (blank lines between allowed) is read with that heading as its block, the lines put back where they were, and the body is what follows the heading.
  The line comes apart without guessing at key names: a plain YAML scalar cannot hold `: ` or ` #`, so the writer quotes any value that does (`title: "Meeting: updated: plan"`), and a quoted value is read to its closing quote before the next `key:` is looked for; a long value the writer folded comes back whole, since YAML reads a fold as the one space Docs joined it with; markdown's escapes (`Cool\!`) come off first.
  It is all or nothing: the pairs must parse without a single error as a block the app wrote — the app's keys and no others, an `id` that is a UUID, `created` and `updated` that read as times, a pin only as `true` — and anything less is all body, as before.
  Only the app's keys, because another tool's key may have a space in it (`date created:`), and cut at its last word it would read as the app's `created`; against the app's own block that cut makes a second `created`, which the parser refuses.
  The file is not touched on read: the note keeps the source Docs wrote until a real edit, which writes the block back between fences and drops the rule and the heading.
  Not recovered: a title holding both kinds of quote (the writer escapes the `"` as `\"`, and markdown takes that escape for its own); a block holding a list, which ends the paragraph before the closing fence and so never becomes a heading; and a row a device read before this, which stays as it was read until its file changes — an edit there writes the heading into the body for good.
- Folder names are user-facing notebook names.
  Reserved prefix: anything starting with `.` is ignored by the UI, except the scratchpad's `.scratchpad` and the vault's `.vault` at the root (below).
- Line endings: `\n`, `\r\n` and `\r` are **read** as one thing, because CommonMark says they are — the parser folds before remark sees the text, and both editors fold what they hand back.
  **Written**, in three parts, because each answers a different question:
  - The *body* is never rewritten by the act of saving metadata.
    A note nobody edited comes back byte for byte, including a line ending sitting between two lines of a fenced code block.
  - The *frontmatter block* is written the way that file writes lines — the body's first line ending; failing that the block's own interior endings; failing both, `\n`.
    Not "whichever ending appears somewhere in the body": one `\r\n` in a code sample would otherwise flip every line of an otherwise-`\n` file.
    The third fallback is reachable and bounded: a block has interior endings only with two or more keys, so a one-key CRLF note whose body has no line ending either is rewritten `\n`.
    Carrying the ending the fences had would close it, and only `splitFrontmatter` ever sees that.
  - A body that has been through *either editor* is `\n` throughout, and the block follows it.
    That is where normalization happens, and it happens only after a real user edit — including the endings between the lines of a code fence, which CommonMark counts as line endings rather than as the block's content.
    The raw editor has always done this; the rich editor now does it too, rather than the two disagreeing.
  (Amended twice: this first read "normalized to `\n` on write", which made adding an id on import a whole-file rewrite of every Windows-authored note; the amendment then claimed no file the app writes mixes endings, which was not true of a body carrying one inside a code fence, and is now stated as a promise about the block rather than about the file.)
  UTF-8 only.
- **Attachments** (2026-10-03, #187).
  An image or any other file added to a note is stored **beside it**, in the note's own folder, and linked from the body as ordinary relative markdown: `![Holiday](holiday-3f9a1c2b.jpg)` for an image, `[Q3 report.pdf](q3-report-3f9a1c2b.pdf)` for anything else — what every other editor and every provider's own preview already reads.
  Nothing about it is a format of the app's own.
  - **Named by content** (`attachmentName` in `names/slug.ts`): `<slug of its name>-<first 8 hex of its SHA-256>.<ext>`, or `pasted-image-<hash>.png` for a picture from the clipboard, whose own name says nothing (a pasted file that is not a picture keeps its name).
    The same file added twice under one name, here or on another device, is one name and one file; a clash between two different files is the rare case, and where the 8 hex are already taken by a file of another size the name takes 16.
    The name the user knows the file by is the link text (an image's alt is its name without the extension, any other file's is its name), so renaming it is editing a link, and **no note body is ever rewritten to rename a file**.
    The stem is cut to leave a conflict suffix room inside the 255 bytes a name may have.
    The extension is the name's own, folded, where it is ASCII letters and digits, and otherwise from the type the browser gave (`bin` where neither says).
    **Never `.md`**: a file by that name is a note to every device.
  - **A link is a file** when its destination is relative — no scheme, no leading `/`, and no `#`, `?` or `\` — and its last segment is a name with an extension other than `.md` (`isAttachmentHref`).
    Every question is asked of the destination as a browser's URL parser would read it, with what surrounds it and every tab and newline in it dropped, so `\tjavascript:…` is not taken for a relative path.
    Each segment is decoded on its own once the destination is split, so an escaped separator cannot make one segment two — `x.md%2F` is not a file, and is not the note `x.md` either — and a segment that decodes to a `/`, a `\` or a control character names nothing.
    It is resolved from the note's folder with a `..` that may not climb out of the app folder (`resolveRelative`): `normalizePath` drops such a `..` silently, which would turn `../../../a.png` from a note at the top into `a.png`, a file the link never named.
    What a note links (`linkedFiles`) counts images, links, the definitions reference-style links use, and `<img src>` in raw HTML, read as a browser reads a tag; not code, not the web, nothing hidden, nothing in an HTML comment.
  - At most 25 MiB each (`MAX_ATTACHMENT_BYTES`): "25 MB" to the person told it, and the larger of the two things a device means by that, so nothing a device calls 25 MB is refused.
  - **Nothing in a file runs as the app.**
    A file opens in a tab only as one of a fixed list of image, audio, video and PDF types (`safeOpenType`), and everything else — SVG, HTML and XML among them — as `application/octet-stream`, which downloads: a `blob:` URL is the app's origin, and a document opened there would have the storage credential in reach (§9).
    An SVG is still drawn in a note, through `<img>`, and from a `data:` URL rather than a `blob:` one (`drawsFromData`): a picture is one "Open image in new tab" from being a document of its own, and a `data:` document's origin is opaque.
- **The clipboard** (2026-10-06).
  `.clipboard/` at the root holds the clipboard a source's devices share, one file per item, where the user has shown it (§7, "The clipboard").
  Hidden, so no device takes anything in it for a note, a file or a notebook.
  An item is named `<UTC stamp to the millisecond>-<attachmentName>` (`clipName` in `packages/core/src/files/clipboard.ts`): `20261006T153012123Z-text-3f9a1c2b.txt` for text, `…-pasted-image-<hash>.png` for a picture, `…-Q3 Report-<hash>.pdf` for a file.
  The stamp orders the items and the hash says when a paste is one already there.
  **A file keeps its own name (2026-10-14, the owner's ask).**
  It was the name's slug, as an attachment's is, `…-q3-report-<hash>.pdf`.
  But an item is shown and saved by the name read back from its file (`readClipName`), and with no link to hold the name the user knows it by, "Q3 Report.pdf" came back as `q3-report.pdf`.
  Its stem now loses only what a notebook's name loses (`kept` in `attachmentName`, the rules of `sanitizeFolderName`): control characters, and the characters `UNSAFE` holds hostile on a disk or a provider, which takes the parentheses of "Report (1).pdf" too.
  Its spaces and capitals stay.
  The extension is still folded, because a version before then reads a name only with a lowercase extension (`NAME`), and a device not yet updated would otherwise leave the item out.
  An item pasted before keeps its slug, since a name is never rewritten.
  A `.md` file keeps `.md`, which `attachmentName` refuses beside a note: in a hidden folder it is no note.
  **No index file**: two devices pasting at once would each write their own version of one, and one paste would be lost.
  A name is written once, by the device that pasted, and never written into, so the folder's listing is the whole of the clipboard.
  At most 10 items (`CLIPBOARD_ITEMS`): a paste past that deletes the oldest.
  A name the app did not write (`readClipName` answers `undefined`) is left alone.
- **The scratchpad** (2026-10-07).
  `.scratchpad/` at the root holds a source's scratch notes (§7, "The scratchpad").
  Each is an ordinary note, named, written and synced as any note is; only the folder is the scratchpad's.
  `isHidden` makes an exception for it, as it does for `.vault/` (below): a first segment that is exactly `.scratchpad` is not hidden, so the engine, export and import take its notes as notes.
  A dot name inside it (`.scratchpad/.DS_Store`) is still hidden, and so is `.clipboard/`.
  `isScratchPath` (`appFolder.ts`) says whether a path is in it.
  A scratch note may carry two keys a notebook's does not: `pinned: true` and `color: <name>`, one of `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple` and `pink` (`SCRATCH_COLORS`).
  Unpinned and no colour are written by taking the key away, and a colour the app does not know is read as none and left in the file.
  Both are taken away when a note leaves the folder for a notebook.
  Neither is part of what makes a block metadata, since a note's first line may be `Color: …`.
  In the scratchpad, where a note need not have a name, `untitled-2.md` is as unnamed as `untitled.md`; in a notebook it stays a name, as it always was.
  **A cursor read while the folder was hidden** (2026-10-08) had passed over every scratch note other devices had sent by then, and a feed names a file again only when it changes, so a device that updated after the notes were made never had them.
  Schema version 10 drops every source's cursor once, as "Re-scan" does (`rootId` kept), and the next sync is a scan, which reads nothing the device already holds at its version.
  Any later change to what `isHidden` lets through needs the same.
- **Secrets** (2026-10-14, §7, "Secrets in a note").
  A secret in a note is an armored [age](https://age-encryption.org/v1) file in a fenced block whose info string is `age`, and after it, where the user has given one, the secret's label in plain text (2026-10-15):

  ````markdown
  ```age
  -----BEGIN AGE ENCRYPTED FILE-----
  YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBu...
  -----END AGE ENCRYPTED FILE-----
  ```
  ````

  How it was made is said by the file's own header, not by the fence, which says nothing else: ```` ```age Wi-Fi password ```` is a secret called "Wi-Fi password", and anyone who can read the folder can read that, though not the secret.
  Milkdown's code block keeps a fence's first word (`language`) and writes nothing else of the info string back, so the secret's own node carries the rest (`secretBlock.ts`), exactly as written.
  A version before 1.6 drops it there, which the rich editor's fidelity check catches, so such a version opens a note with a label in raw mode and loses nothing.
  Any CommonMark reader shows the block as code, and `age -d` decrypts it.
  `.encryption.json` at the root holds the source's recipient — the public half of its key — and nothing secret.
  It is hidden, so the engine passes over it, and only "Set up vault" and "Replace key" write it:

  ```json
  { "schemaVersion": 1, "recipient": "age1…", "setAt": "2026-10-14T18:02:11Z" }
  ```

- **Passwords** (2026-10-15, §7, "Passwords in the vault").
  `.vault/` at the root holds the vault's passwords, one note each, named as a note is from its title, which is the item's label: `.vault/github.md`.
  `isHidden` makes the exception for it that it makes for `.scratchpad/`, so the engine, export and import take its notes as notes — a download of the source has them, and importing that download brings them back as passwords, still encrypted to the key they were made with — and a dot name inside it is still hidden.
  `isVaultPath` (`appFolder.ts`) says whether a path is in it.
  The label is plain text, in the file's name and its `title`; the rest of the item is the note's body, one `age` fence with no label, as "Secrets" above sets one out, and nothing else, whose words are a JSON object:

  ```json
  { "username": "ada@example.com", "password": "…", "notes": "…" }
  ```

  `age -d` gives the object back.
  A key the app does not know is kept where it is when an item is edited, so a later version can add fields (`totp`) that an earlier one does not lose.
  Two are known since 2026-10-16 (§7, "Filling in on a site"), and are written only where they hold something:

  ```json
  { "urls": ["https://example.com"], "previousPasswords": [{ "password": "…", "replacedAt": "2026-10-16T12:00:00.000Z" }] }
  ```

  `urls` is the item's Site, the addresses it fills on (`vaultUrls`); `previousPasswords` the passwords an Update from a site replaced, newest first, five at most (`vaultPrevious`, `withReplacedPassword`).
  Either in a shape this version does not know — not an array, or an entry that is not text, or not a `password` and a `replacedAt` — is kept as it is and not edited: an item whose `urls` is unknown is never filled, and one whose `previousPasswords` is unknown is not updated from a site.
  An entry of `previousPasswords` keeps any key a later version adds to it.
  It writes them as text, objects or arrays: a number goes back only as precisely as a double holds it, and of two keys of one name only the last (`readVaultPayload`).
  The app does not write over an item it cannot read: a field that is not text, words that are not an object, or a body that is anything but its one fence — words added beside it in another app, a label on the fence, a second block (`vaultArmor`).
  A version from before passwords takes the folder for hidden, as every version took `.scratchpad/` before the scratchpad: it neither pulls an item nor deletes one, and it does not encrypt one afresh when it replaces the key, which a device that has updated catches up (§7, "Catching up").
  A cursor read while the folder was hidden has passed over every item made since, so schema version 12 drops every source's cursor once, as version 10 did for the scratchpad.

---
## 4. Provider adapter interface

Every provider implements this.
The sync engine only talks to this interface.

```ts
export interface RemoteEntry {
  remoteId: string;        // provider file id; the path itself on WebDAV
  path: string;            // relative to app root, POSIX separators, normalized
  kind: 'file' | 'folder';
  version: string;         // etag / rev / cTag / headRevisionId — opaque, compare for equality only
  modifiedAt: string;      // ISO
  size?: number;           // bytes; on every file entry, a ConflictError's remote too; absent for folders
}

/** What read/move/delete need, which is all the local store keeps. */
export type EntryRef = Pick<RemoteEntry, 'remoteId' | 'path'>;

/** A path, an id, or both: Dropbox's DeletedMetadata has no id, and an id feed may know no path. */
export type DeletedEntry =
  | { path: string; deleted: true; remoteId?: string }
  | { path?: undefined; deleted: true; remoteId: string };

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

export interface CreateFileOptions {
  /** Recorded where the provider keeps one (Drive's `mimeType`); decides nothing here. */
  contentType?: string;
}

export interface StorageProvider {
  readonly kind: ProviderKind;
  /** Whether `list` reports everything a folder holds. False on Drive (§5.1). */
  readonly listsEverything: boolean;
  /** Where that is false, marks a folder emptied here instead of deleting it (§5.1). */
  readonly leaveFolder?: (entry: EntryRef) => Promise<void>;
  readonly ensureRoot: () => Promise<{ rootId: string }>;
  readonly list: (folderPath: string) => Promise<RemoteEntry[]>;
  readonly read: (entry: EntryRef) => Promise<{ content: string; version: string }>;
  readonly write: (path: string, content: string, opts: WriteOptions) => Promise<RemoteEntry>;
  readonly readBytes: (entry: EntryRef) => Promise<{ bytes: Uint8Array; version: string }>;
  readonly createFile: (path: string, bytes: Uint8Array, opts?: CreateFileOptions) => Promise<RemoteEntry>;
  readonly createFolder: (path: string) => Promise<RemoteEntry>;
  readonly move: (entry: EntryRef, newPath: string) => Promise<RemoteEntry>;
  readonly delete: (entry: EntryRef) => Promise<void>;
  readonly changes: (cursor?: string) => Promise<ChangeSet>;
}

export class ConflictError extends Error { constructor(readonly remote: RemoteEntry) { … } }
export class AuthError extends Error {}          // engine asks the backend for a fresh token
export class NotFoundError extends Error {}      // entry gone, or expectedVersion for an absent path
export class CursorResetError extends Error {}   // cursor unusable; discard it and full-scan
export class UnreadableError extends Error {}    // the file is there and is not UTF-8 text; carries the path asked with
```

Three shapes differ from the sketch this section used to carry.
Members are property signatures rather than methods, which is both the house style (`EntitlementProvider`) and what `functional/prefer-property-signatures` requires.
`kind` reuses `ProviderKind` from `config.ts` so `PROVIDER_KINDS` stays single-sourced with the marker schema.
And `read`/`move`/`delete` take an `EntryRef`, not a whole `RemoteEntry`: a note record persists only `remoteId`, `remoteVersion` and `path`, so passing the full entry would have every caller inventing a `kind` and a `modifiedAt` — and let an adapter come to depend on the invented value.

`NotFoundError` and `CursorResetError` are additions.
A cursor can go stale on every provider (Dropbox answers `reset`, Graph `410 resyncRequired`, WebDAV invalidates its sync-token) and without a type for it the engine cannot tell a dead cursor from a transient failure, so it retries forever.
`NotFoundError` is what lets `ConflictError.remote` stay non-optional.

Each error carries a `code` alongside its class, and ships with an `isXError` guard.
`instanceof` is the ergonomic check and is correct today, since `@skysa/core` resolves to one module per bundle; the code keeps the guards honest if core is ever published and a consumer ends up holding two copies of it either side of a sync boundary.

Semantics the signatures do not carry:

- `listsEverything` is what the engine asks before removing a folder because a listing showed it empty (§7).
  It is false on Google Drive alone: `drive.file` shows the app only the files it created, so a folder that lists empty may hold a file the user put there, and deleting it would take that file.
  Every other capability question is answered by behaviour rather than a flag; this one cannot be, because the wrong answer is silent and costs a file.
- `write` is create-or-update, never a blind overwrite.
  No `expectedVersion` means "I expect nothing here" — literally WebDAV's `If-None-Match: *` — so a file already at that path is a `ConflictError`.
  That is what makes §7's "remote deleted, local dirty → re-create on push" safe: if the file came back in the meantime the write conflicts instead of clobbering it.
  An `expectedVersion` for a path with no file is a `NotFoundError`.
- `createFolder` and `delete` are idempotent, so a queued op is always safe to replay.
- `move` may or may not change `version` — Dropbox's `rev` survives it, OneDrive's `eTag` does not — so the caller stores the returned entry rather than assuming either way.
  `remoteId` survives a move on every id-based provider; on WebDAV it *is* the path and so cannot, which is why renames there are re-linked through frontmatter `id`.
- A deletion is identified by its id when it has one and by its **path** when it has not.
  Dropbox's `DeletedMetadata` carries a name and a path and nothing else — no id, no rev, no timestamp — so `ChangeEntry` is a union rather than an entry with a flag.
  Anything richer would have adapters fabricating fields and the engine trusting them.
  And the path may be missing where the id is not: an id feed asked about a file its tree never placed — one this device pushed after its cursor, deleted by another device before this one pulled again — has no path to give, and dropping the deletion leaves the note on this device for ever.
- `list` is one level.
  `changes` covers the whole tree at every depth.
  Neither filters hidden paths: `.notesapp.json` has to reach the engine, and the UI filters with `isHidden`.
- `rootId` is opaque, non-empty and stable.
  A provider whose root has no id of its own — a Dropbox app folder, where the root simply *is* `/` — returns a synthetic constant.
- Content is UTF-8 text, and `read` says when it is not.
  The body is taken as bytes and decoded strictly (`providers/text.ts`); bytes that are not UTF-8 are an `UnreadableError` carrying the path, never text with U+FFFD where the bytes were.
  A lossy decode looks like a note, and the first push then writes the damage over the original.
  Text holding a U+0000 is refused the same way: UTF-16 without a BOM, and most binaries, are valid UTF-8 to a decoder with a NUL for every other byte, and markdown never carries one.
  A UTF-8 BOM is stripped, as `response.text()` always did, so hashes do not move; it is still lost on the first push, as it always was.
  A probe that only asks whether a file exists takes `UnreadableError` for yes (§7).
  That is `read`, and `read` is for notes.
  Every other file — an attachment beside the note that links it (#187) — goes through `readBytes`, which hands the bytes over exactly as stored, a BOM included, and never raises `UnreadableError` (2026-10-03).
  Each adapter's `read` is its `readBytes` decoded, so the two agree on what is there and on every other error.
- `createFile` is create-only, and there is no update to go with it: the app never writes into a file that is not a note, and a name stamped with the file's content (#187) is never asked to hold other bytes.
  A file **or a folder** already at the path is a `ConflictError` whose `remote` carries its `kind` and, for a file, its `size` — what lets an upload that finds its own name taken tell its own earlier upload (the same size, under a name made from a hash of the bytes) from someone else's file.
  A missing parent may be `NotFoundError` or may be made, as for `write`.
  `contentType` is recorded where the provider keeps one and decides nothing; the extension is what the app reads.
  Every adapter sends the bytes in one request: a provider takes at least 150 MiB in one everywhere but Drive, which over 5 MB wants a resumable session, also sent in one `PUT` (§5.1).
- No `AbortSignal` in the adapter interface: operations are short and the engine discards results it no longer wants.
  **But the `fetch` an adapter is given is cancelled with its session (2026-09-23).**
  The web app's `timedFetch` (`apps/web/src/sync/providers.ts`) combines each request's own 60 s timeout with the scheduler session's signal, so ending a session — Cancel on an import, a disconnect, a switch of source — stops a download in flight instead of leaving it to run out its timeout.
  The contract is unchanged; an adapter sees an aborted `fetch` as the network error it is.
  **The timeout grows with the bytes (2026-10-03, #187).**
  A minute is a note's upload or a page of changes on a slow connection, and a 25 MB attachment at the 50 KB/s the app still means to work on takes over eight.
  So a request gets 1 ms per 50 bytes it sends or receives on top of the minute: what it sends from the start, and what its answer holds from when the answer begins — the bytes its `Content-Length` says, at once, or, where it gives none (Dropbox does not promise one), each chunk as it arrives, so a download that keeps coming is never cut off for want of a header and one that stalls still is.
  The answer adds to what is left rather than replacing it, so a large upload answered late keeps the time it earned, and a download keeps the rest of its minute as slack.
  A note or a page of changes keeps the minute, give or take a millisecond.
  What the bytes earn is credit spent when the timer comes due, so the deadline only moves later and no clock is read: a wall clock that jumps cannot bring it on early.
- A provider asking us to slow down is `RateLimitError`, with the `retryAfterMs` it gave: Dropbox and Graph answer 429, Graph also 509 for the bandwidth cap, and Drive a 403 whose reason names the quota (`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `sharingRateLimitExceeded`).
  **A 503 is not a rate limit, `Retry-After` or not.**
  Graph's throttling guidance names one status — "use the HTTP error code 429 to detect throttling" — and its error table calls 503 "temporarily unavailable for maintenance or is overloaded" whose delay is "the length of which can be specified in a `Retry-After` header".
  So the header does not tell an outage from throttling: both carry one.
  Since a rate limit is not counted against the op (§7), a 503 read as one would retry for ever — never blocked, never surfaced, with every op behind it waiting — so it stays the counted failure any other 5xx is.
  Drive's newer error bodies put the condition in `error.status`, and `RESOURCE_EXHAUSTED` there is read as a quota **only where Drive gave no `errors[]` reason at all**: the reason is the more specific answer and some are deliberately left out, `storageQuotaExceeded` above all, which is a full Drive that no wait fixes and which `google.rpc.Code` gives the same `RESOURCE_EXHAUSTED` as a per-user quota.
  (Drive's errors page documents no `status` field; whether it ever sends one is on the Phase 4 live-check list.)
  `Retry-After` is read as seconds or as an HTTP date: seconds is what Graph documents and a date is legal (RFC 9110 §10.2.3) and is what some fronts send, so both are read, and of a value `Headers.get` has joined from a header sent twice ("7, 30") the *longer* wait is taken — coming back early is refused again, coming back late costs only the wait.
  Dropbox's `retry_after` comes out of the JSON body instead; an unreadable value says nothing rather than zero, and the caller falls back to its own backoff.
  It is a type of its own for two reasons: it says nothing about the request, so the engine does not count it against the op's attempts (§7), and the provider's own answer for how long to wait beats any backoff we could guess.
  Other transport failures (5xx, a dropped connection) stay plain errors on the engine's per-op backoff.

Adapter contract tests: the scenario suite is `describeProviderContract(name, harnessFactory, { stableIds })` in `packages/core/tests/providers/contract.ts` — a helper rather than a test file, so Vitest's `tests/**/*.test.ts` glob does not collect it on its own.
`tests/providers/contract.test.ts` is the registry every adapter is added to: the in-memory fake in CI, and live accounts via `PROVIDER_LIVE_TESTS=1` locally.
Each HTTP adapter is one row of a table there, which registers it over its wire stub at one entry per page and at full pages, and against a live account when its token is given.
The stubs share how they answer and record a request (`tests/providers/harness.ts`).
`stableIds: false` exempts path-based providers from the move-preserves-id scenarios.

Scenarios: idempotent `ensureRoot` including write-the-marker-only-if-absent, path normalization at the adapter edge, byte fidelity on read-back, the four `write` cases above, one-level `list` including hidden entries, idempotent `createFolder`, the root (a note or file written at it, or a move onto it, is a `NotFoundError`, and `createFolder('')` answers it as a folder already there — Dropbox had no guard, and its stub now refuses a write path `files.stone` does not allow, as Dropbox does), move (file, into a folder, whole folder rebasing its descendants, onto an occupied path), idempotent recursive `delete`, and a `changes` feed that scans current state on a cold start rather than replaying history, reflects each step, survives being persisted, and is drained through its `more` loop.
And a file that is not UTF-8 text: `read` is an `UnreadableError`, while `list`, `changes`, `move` and `delete` treat it as any other file and leave its bytes as they were.
No adapter can rewrite a file with such bytes, so the harness may offer a way in underneath (`plant`, `bytesAt`) — the fake's `plantBytes` — and a live registration, which has none, skips these.
And a file that is not a note, through the port alone so that a live account runs it too (2026-10-03): every byte value, an empty file and a 6 MB one (over Drive's multipart limit) come back byte for byte, at the version `createFile` reported; `readBytes` keeps a BOM; `read` of one is an `UnreadableError`; `createFile` over a file, a note or a folder is a `ConflictError` whose `remote` says what is there — its kind and, for a file, its size — and leaves it as it was; it is listed and in the feed with its size in bytes; and it moves with its bytes, and once deleted is `NotFoundError` to `readBytes`.
The wire stubs read every request body as bytes (`tests/providers/wireBody.ts`) and refuse one they cannot read: they used to take anything but a string as empty, so an upload of bytes would have arrived as an empty file with every test passing.

The in-memory fake in `src/providers/fake.ts` — reached by the apps' tests as `@skysa/core/testing`, with the three provider stubs and the store contract, and never by anything they ship — is deliberately the strictest provider in the repo: where this section leaves a case open it takes the least forgiving reading, because a lenient fake lets the engine grow assumptions that only fail against a real account.
It never creates a missing parent, re-versions even a byte-identical write, and never reuses an id.
It holds every file as bytes, whichever method wrote it, so a stub can hand any upload to it; its `createFile` is as strict as `write`'s create, and `plantBytes` — another tool saving over whatever is there, with no version check — is for tests alone.
Its `pageSize`, `folderChanges` and `setFault` options are what let the engine's drain loop, folder rebasing, and auth-retry paths be tested at all.

---

## 5. Provider specifics

### 5.1 Google Drive
- Scope: `https://www.googleapis.com/auth/drive.file` plus `openid email` for identity.
  Non-restricted; standard OAuth verification only.
- Root: a folder `APP_FOLDER_NAME` (mimeType `application/vnd.google-apps.folder`) at the top of My Drive, tagged `appProperties: { notesapp: "root" }` and found by that tag, never by name, so a user who renames or moves it keeps their notes, whatever it is called.
  **Only `ensureRoot` and a round from nothing make one**: a pull on a stored cursor, and every read and write, only look (a search that misses the folder for a moment is an error to retry, never a second folder).
  Where one is made, the search is asked again, and every tagged folder but the earliest is folded into it — what is inside moved across (the marker trashed instead where the earliest has one), and a folder put in the trash only when a fold finds it already empty, since a device whose last pull was against it may still be writing into it; that device's next pull resets and folds again.
  That settles two devices connecting at once, and a folder restored from the trash beside the one made while it was gone, with nothing written to either left unread; names that meet in the move are separated by the scan that follows.
  A pull on a stored cursor is reset (`CursorResetError`) when an earlier tagged folder exists, when the folder is trashed or gone (asked of the folder itself when the search does not list it), or when the feed says so — read from `removed` and `trashed` as Drive sent them, not from the tree, which takes a name no path can hold as gone.
- Names are not unique on Drive: a folder may hold two `a.md`.
  A path is resolved by walking names from the app folder (`name = '…' and '<parent>' in parents and trashed = false`, with `'` and `\` escaped, compared exactly afterwards), and where a name matches more than once the **canonical** item — earliest `createdTime`, then lowest id — is what the path means, on every device.
  No id cache: one would send a write into the wrong folder after a remote rename, and notes sit a few levels deep.
- Nothing on Drive is conditional: v3 has no `If-Match` and nothing like create-if-absent.
  - Create: look up the name (taken → `ConflictError`, parent missing → `NotFoundError`), upload with `POST /upload/drive/v3/files?uploadType=multipart` (`text/markdown`, bytes exactly as given), then **search again**: if another device's file of that name was made earlier, ours goes to the trash (a third device may already have written into it) and `ConflictError` names theirs, so the engine makes its conflict copy.
    A folder is made the same way, and one that exists already is returned.
  - A file that is not a note (`createFile`, 2026-10-03, #187): the same look, create and look again, with the bytes as the multipart body's second part and the given type as its `mimeType` (`application/octet-stream` if none).
    Over 5 MB, where Drive's guide stops recommending multipart, it is a resumable upload instead — for a note that size too, which goes the same way: `POST …?uploadType=resumable` with the metadata, then every byte in one `PUT` to the `Location` that answers it (https://developers.google.com/workspace/drive/api/guides/manage-uploads).
    That `Location` is used only on `www.googleapis.com` — the host the token is for, and the one `connect-src` allows — and refused anywhere else rather than sent the token.
    The `PUT`'s answer is not relied on to carry the fields the session asked for, so a file with no `headRevisionId` in it is asked for by id.
    **Two things to check against a live account** before attachments are built on this: that Drive exposes `Location` to a page on another origin (CORS hides a header it was not told to expose, which reads as `null`, and the upload then fails with nothing sent), and that `?alt=media` for a file of several megabytes is still served from `www.googleapis.com` rather than redirected (below).
  - Update: by id, never by path — a file deleted since the caller saw it is `NotFoundError`, never made again.
    `headRevisionId` is compared with the expected version (`ConflictError` if it moved), then `PATCH /upload/drive/v3/files/{id}?uploadType=media`.
    A write landing between the two is overwritten; the next `changes` pass reports the result.
    Nothing written on this device is lost, and what the other device wrote in that moment may be — inherent to v3.
  - Move: `PATCH files/{id}` with `{ name }`, and `addParents`/`removeParents` only when the folder changes.
    The destination is looked up first, so a replayed move returns without a `PATCH`.
  - Delete: `PATCH { trashed: true }` — to the trash, not gone for good, so the user can restore a note from Drive as from OneDrive's recycle bin.
    A 404 is success.
- Reading: `GET files/{id}` for `headRevisionId`, **then** `?alt=media`, both on `www.googleapis.com` with the token.
  In that order the version reported is never newer than the bytes; Drive can download a past revision only if it was kept forever, so the two cannot be pinned together.
- Version: `headRevisionId`, which changes with content and not with a rename or a move (like Dropbox's `rev`).
  Folders have none.
  A file with none (a Google Docs file, which this app never makes) is left out of `list` and `changes`.
- Changes: the cursor is JSON `{ v, phase, token, start, root, nodes, pending, walked? }`, the tree kept in `packages/core/src/providers/idTree.ts` as for OneDrive (§5.2).
  A round from nothing asks `changes.getStartPageToken` **first**, then scans `files.list q=trashed = false` — every file the app can see, which under `drive.file` is every file it made — and follows `changes.list` (`includeRemoved`, `newStartPageToken` ends a round) from that token after.
  A `removed` change (deletion or loss of access) or a file with `trashed` (set too when a folder above it is trashed) is gone.
  On a stored cursor, a 404, a 410, or a 400 whose error names the page token (in `location`, reason or message) is `CursorResetError`; any other 400 is a failure to retry, not a rescan.
  What Drive actually answers for a dead token is undocumented.
- **A long feed becomes a scan (2026-10-14).**
  Reported from a phone: "Checking for changes…" took a long time and found little, and pausing it for a full re-scan was quicker.
  Measured on that Pixel against the live account: after a day away, with the account busy elsewhere, the round read **60 empty pages** of `changes.list` before the 16 holding the notes another device had imported.
  That was about 45 s with nothing found.
  A check straight after a sync was one page, 0.7 s.
  `drive.file` hides every change the app cannot see, but Drive still pages through them, so a feed round grows with the whole account's activity since the last look, while a scan lists only the app's own files, a page per thousand.
  Two changes.
  First, the app folder is looked for **once a round**, at its first page, not before every page: that search was half of each page's cost (about 0.34 s of 0.7 s).
  Mid-round the feed itself reports the folder going to the trash (`rootGone`).
  A cursor stored mid-round and read by another session, which has not looked this round, looks again.
  Second, a feed round that has read **twice the pages a scan would take, plus two** (`feedLimit`: the tree's size, a thousand a page), and has not ended, throws `CursorResetError`, and the engine's answer to that is the scan.
  Nothing read is half kept: a feed round is read whole before any of it is applied (§7), so the reset meets nothing committed, and the stored cursor stays as it was for a scan that is interrupted.
  The count travels as `walked`, on cursors written mid-round only.
  One written before it was added is a round's start, so no cursor resets for it.
  A round with real changes on many pages scans too.
  That is the same answer by the shorter road, since a scan is the truth a re-scan already relies on.
  Empty pages are not saved as they are read, and are not shown as progress: with the limit, there are at most a few of them.
  Making scans common in the two-device model found a mistake only a scan could make.
  A note deleted on one device was given the other device's file that had taken its name, and its delete removed that file.
  It is fixed in the same change (§7, "A path can be reused").
- Drive lists no parents of a changed item, so a round's end means only that every ancestor of what it listed is in the tree or was listed: a folder that becomes placed without having been (moved in from outside the app folder, or rescued from one deleted) has its contents **listed recursively into the same page** (`arrivals`), since the feed will not name them.
  A folder made on another device since the last look arrives the same way, so after notebooks are moved there every folder of them is listed.
  That was one request at a time, a wait per folder before the round could say anything.
  Since 2026-10-13 they are asked a level at a time, four folders at once (`LISTS_AT_ONCE`, as many as writes; a list is 100 of the 325,000 quota units a user has a minute).
  The answers go into the page in the order one at a time put them, so nothing the page makes of its order moves.
  The query is the same single-parent `'<id>' in parents` the live suite checked; one asking for several parents with `or` would be fewer requests, but has not been run against Drive.
  An item a round ends without placing has left the app folder — moved elsewhere in Drive, or into a folder the user made in the Drive UI, which `drive.file` cannot see — and is reported deleted where it was.
- **Two items at one path never reach the engine**, which holds one note per path: with two, it would move one note aside locally on every pull, alternately, and an edit to the one moved aside would be written to a path with no file behind it for ever.
  When a page places two items with one folder and name, the adapter asks Drive whether both are still there — the search, and then each one the search leaves out, by id, since the feed can announce a file before the index lists it and a clash passed over is not asked about again until one of them changes; if so the canonical one keeps the name and each other is renamed beside it with `PATCH { name }` to `conflictFilename`/`conflictFolderName` (§7's rule applied to two remote files), and reported there.
  A file that is not a note is renamed with `conflictNameKeepingExtension` instead, which puts the stamp before its own extension (`photo (conflict 2026-09-15T14-32).png`): `conflictFilename` would have made it `photo.png (conflict …).md`, which is a note to the engine and no longer a picture to anything else.
  And one whose `md5Checksum` and `size` equal the canonical item's is not renamed at all: it is a copy, so it goes to the trash and is reported deleted (2026-10-03, for attachments, #187).
  Drive has no conditional trash, so the copy is asked for by id once more just before, and one moved, trashed or rewritten since it was listed is left to the feed or renamed instead; that narrows the race to one request rather than closing it, and a file lost in it is in Drive's trash, not gone.
  Two devices uploading the same picture while offline will be the ordinary way to get there, since an attachment's name is to be stamped with its content (#187), and renaming the second would leave a file no note links to beside the one they all do.
  Never a note: two notes with the same bytes are two rows on whichever devices hold them, and one sent to the trash would be a remote delete to each, so notes are renamed as they always were.
  A tree that still holds a file under a name it has since left is not a duplicate, so the tree alone never triggers a rename.
  Two devices separating the same pair at once each rename the same file; the last `PATCH` wins, and the next pull reports the name that stuck.
  So a pull can write to Drive, which no other adapter's does.
- **A folder the app has left (2026-10-13).**
  Reported from a phone: notebooks moved into an Archive notebook on a desktop, and the phone showed every old one still there, empty — and again after a re-scan, because the directories were still on Drive.
  A notebook moved, renamed or deleted goes up as its notes moving or going and then an `rmdir` for each directory it left (§7, "Folder renames/moves"), and on Drive that `rmdir` never deleted anything: `drive.file` hides what the user put in a folder, and trashing it would trash that too.
  It now *leaves* the folder instead (`StorageProvider.leaveFolder`).
  Past the same gates as a delete, one `PATCH` sets a private `appProperties` key on it — `notesappLeft`, a key of its own, so nothing can touch the app folder's `notesapp` — and nothing in it is touched.
  The adapter keeps a left folder in its tree, since what is inside one is placed through it, but does not report it while it holds nothing the app can see: no file, and no folder that is not left too, at any depth (`hideLeftFolders` in `providers/idTree.ts`).
  It has to be the adapter that decides and not the engine: told a folder is deleted, the engine takes the clean notes under it off the device, so "nothing is in it" has to be judged against the whole remote tree, which only the cursor holds — and judged again whenever what is in it changes, not only when the folder itself does.
  So a feed page compares the tree before it with the tree after: a folder hidden now and not before is reported deleted, after everything else the page says, so what the page moved out of it is out first; one hidden before and not now — a note written into it, or the mark taken off — is reported as a folder again; one hidden throughout is not mentioned.
  A scan holds every left folder back until its last page and then reports the ones something keeps, so a hidden one is never mentioned and `reconcile` takes it off a device that still has it; what is inside a kept one can arrive first, and the notebook made to hold it takes the folder's id when the folder's entry comes.
  `createFolder` takes the mark off the folder it finds at the name, and off another device's that wins the race to make it, so a notebook made again where one was left is a notebook on every device; a folder never left costs no extra request.
  `list` still lists a left folder: it is there, with whatever the user put in it.
  The mark travels in the cursor as a fifth element on a left folder's tree row and on no other, so a cursor stored before it reads as it did, and OneDrive's is byte for byte what it was.
  What the user put in a left folder stays on Drive untouched, and invisible here as it always was.
  Folders left behind before this have no mark, and stay notebooks until they are removed again from a device.
  **Not yet measured against a live account:** that Drive's change feed reports a change to `appProperties` alone — the reference says only that a change's `file` is "the updated state of the file".
  The stub reports it; the first live check is on staging.
  If the feed does not, another device learns that a folder was left only when it next scans.
- Known gaps.
  The engine commits page by page, where the feed means a round — the gap §5.2 describes, and Phase 6's item answers for both.
  A folder emptied here is not removed from Drive, since no listing can show that it is empty; it is left instead, and hidden while it holds nothing the app can see (above, and §7, "A folder is removed only where a listing can prove it empty").
  A search that misses the existing app folder at a reset still makes a second one — unless it is the folder this page last made, found or confirmed, which is asked for by id and counted unless it is in the trash or out of reach (so a first connect, where `ensureRoot` and the first pull's reset come seconds apart, makes one) — and the scan under it deletes this device's clean notes until a later round finds the earlier folder, resets back to it, and folds the second into it (the files are untouched remotely).
  A pull on a stored cursor costs one tag search before its page.
  Files the user adds through the Drive UI are invisible under `drive.file`.
  The storage panel says so (`UNSEEN_AT_PROVIDER` in `apps/web/src/sync/account.ts`, 2026-10-05) — from "About Google Drive" in its gear, or in a compact window in the source's `⋯`, over everything (2026-10-06; a compact window had it as a fold-out under the source's name) — since nothing else does: a user who emptied the app folder on the Drive website and copied a folder of old notes into it saw the deletions arrive and then an empty library, with no word of why.
  The way in for such notes is an import (§7, "Getting a library in"), which makes them the app's files, and the panel's line says so.
- Measured against a live account, 2026-09-21, since none of it is on Drive's reference pages.
  **The change feed lags**: a new file took 1.4–2.8s to appear in `changes.list` on an idle account, and longer under the load of a suite run.
  **It also repeats itself**: one file creation was reported *twice*, about two seconds apart, with the same `version` and nothing having happened in between — so a cursor taken after the first echo still has the second coming, and anything reading the feed has to be idempotent on a repeat it has already applied (the engine is: it compares versions).
  **Name lookup does not lag**: a file was findable by name in 0.3–0.4s, which is what `verify-after-create`, every path walk and finding the app folder at a reset all depend on, and was the worry that made this worth measuring.
  **Deletion lags the other way**: the search index keeps listing a deleted file for a moment, so a scan run straight after a mass deletion finds files whose parent is already gone, cannot place them, and reports them as deletions by id — reachable by a test harness emptying a shared folder between scenarios, not by a user.
  Both lags reached users through the change relay (§6), whose notice comes the moment a write is answered: the round it starts asked the feed before the write was in it, and a clipboard listing taken just after the feed reported a trashing could still name the file.
  So a device looks again after a notice, and lists the clipboard twice (2026-10-06).
- A page token Drive will not take answers **400**, with `message: "Invalid Value"` and `reason: "invalid"` — neither of which says anything about a token.
  Only `location: "pageToken"` does, so the `locations` check in `isDeadToken` is the one doing the work and the message regex beside it is a fallback that would not fire here.
  Confirmed 2026-09-21; `CursorResetError` follows, as §7 needs.
- Trashing and renaming a folder are reported differently, also measured 2026-09-21.
  **Trashing lists what is inside it**: the folder and every descendant arrive, each with `trashed: true`.
  **Renaming lists the folder alone**, with no descendant reported — checked with the feed drained quiet first, because a child created moments earlier echoes into the round and looks like the rename listing it.
  Deleting a folder in the same round as moving a subfolder of notes out of it leaves the notes where the remote has them (§7, "A round is one batch"): the subfolder arrives at its new parent, the old parent arrives removed, and the note under the subfolder survives untrashed.
- `?alt=media` was served **200 from `www.googleapis.com` itself**, with no `Location` header and so no redirect to `*.googleusercontent.com` — which the CSP blocks and which cannot be allowed narrowly, since the wildcard would take in Apps Script web apps (§9).
  Measured once, for a small file; a large one may yet be served differently.
- A first connect leaves **one** app folder, where `ensureRoot` and the first pull's reset both go looking for it seconds apart.
  Confirmed after a real connect: one `skysa-notes` folder, not two.
- Tokens: backend exchanges the auth code with `access_type=offline&prompt=consent` to get a refresh token.
  Access tokens last 1h; client requests a new one from `/api/token` on `AuthError` or proactively at 55m.

### 5.2 OneDrive (Microsoft Graph)
- Scopes: `Files.ReadWrite.AppFolder offline_access openid email`.
  User consent only.
- Root: `GET /me/drive/special/approot` — Microsoft creates `/Apps/<AppName>` automatically, where `<AppName>` is the Entra app registration display name.
  Register it as `skysa-notes` to match `APP_FOLDER_NAME`; no ensureRoot creation logic beyond writing `.notesapp.json`.
- Files, create: `PUT /me/drive/special/approot:/{path}:/content?@microsoft.graph.conflictBehavior=fail` (simple upload, fine for markdown; add a resumable session only if a file ever exceeds 250 MB).
  Graph's default for an upload is to **replace**, so the `fail` is what keeps a create from being a blind overwrite; a name in use answers `409`.
  The adapter looks the path up before raising `ConflictError`; Graph does not say what an upload into a missing folder does (it may make the folders), so a refusal with nothing at the path and no parent folder is `NotFoundError` for the parent.
  A file that is not a note goes up the same way, its bytes as the body and its type as `content-type` (`application/octet-stream` if none) (2026-10-03, #187): a simple upload takes up to 250 MB (https://learn.microsoft.com/en-us/graph/api/driveitem-put-content), ten times the app's cap, so there is still no session.
- Files, update: `PUT /me/drive/items/{id}/content` with `If-Match: <eTag>` → `412` when stale.
  **By id, never by path**: an upload by path creates a file that is not there, and a file deleted since the caller last saw it is exactly what an expected version is meant to catch.
  The adapter looks the path up first for the id (and answers a stale or missing file without uploading); `If-Match` covers the moment between.
- Neither the `conflictBehavior=fail` → `409` nor the `If-Match` → `412` behaviour of an upload is in Graph's reference pages — they come from the OneDrive docs' issue tracker and Microsoft Q&A — and the move page documents only `if-match`, not `conflictBehavior`.
  All three wait on the live run in Phase 3.
- Folders, create: `POST /me/drive/items/{parentId}/children` with `{ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }`.
  **The parent goes in by id, never by path** — the same rule the update above follows, and for a blunter reason: Graph answers a `POST .../children` whose parent is addressed by path with a bare `400 invalidRequest`, at every depth, whatever the name and `conflictBehavior` say.
  Measured against a live personal account 2026-09-21: `POST special/approot/children` 400, `POST approot:/{parent}:/children` 400, `POST /me/drive/items/{parentId}/children` 201.
  `GET .../children` by path is fine, and so is `PUT approot:/{path}:/content`, which is why an app folder could hold its marker and refuse the first notebook beside it.
  The root's id is cached, so only a nested folder costs the lookup.
  The wire stub accepted the path form and so could not catch this: it now refuses it as Graph does.
- Move: `PATCH /me/drive/items/{id}?@microsoft.graph.conflictBehavior=fail` with `{ name, parentReference: { id } }`.
  The parent is named by its real id (Graph refuses `root` there), so a move costs a lookup of the destination and its parent.
  The destination is looked up *first*: a queued move the entry has already made returns without a request, and a rename that changes only the case of a name is still sent.
- Reading: `/content` answers with a `302`, which a cross-origin request carrying an Authorization header may not follow.
  The adapter reads the item for its eTag and `@microsoft.graph.downloadUrl`, then fetches that URL **without** the token: it is pre-authenticated, needs no preflight, and is not on Graph — `*.files.1drv.com`, `my.microsoftpersonalcontent.com`, or `*.sharepoint.com` for work accounts.
  Those are the hosts §9's `connect-src` needs besides `graph.microsoft.com`.
- Version: `eTag`.
  It changes on a move, where Dropbox's `rev` does not — which §7's `syncedHash` answers for a note renamed while it holds unpushed edits.
  `cTag` changes only with content, but delta on OneDrive for Business omits it, so it cannot be the version.
- Changes: `GET /me/drive/special/approot/delta`, following `@odata.nextLink`; the `@odata.deltaLink` is the next start.
  `410` — and, on a link we stored, a `400` (a token Graph cannot read) or a `404` (the app folder it was for is gone) — is `CursorResetError`; the same on the very first request is an ordinary failure, since starting again would ask the same thing.
  Deleted items carry a `deleted` facet and **no `name` at all** — not on Business and not on a personal account either, which the note here used to imply.
  Verified against a live personal account 2026-09-21: a deletion arrives as its id, its `parentReference`, the `deleted` facet and a `file`/`folder` facet, and nothing else.
  The adapter never asks for one (it resolves a deletion by id through the tree), so nothing depended on it, but the wire stub was sending a name no caller could really have and no longer does.
- Paths: **delta never includes `parentReference.path`**, and a renamed folder's descendants are not reported.
  The adapter therefore keeps the tree — id → parent id, name, kind — **in the cursor** (`packages/core/src/providers/idTree.ts`, which Google Drive's adapter shares; what is Graph's own — the link, dead-link rules, the anchoring refusal — stays in `onedrive.ts`), and resolves every path from it once the whole page is applied, so an edit inside a folder renamed in the same page gets the new path.
  Consequences: a folder rename is reported as the folder alone (the engine's folder-only path, as for Drive); a deletion is reported at the path the item had before the page, and one the tree never placed by its id alone (the engine finds nothing for an id it does not hold); an item whose parent has not arrived yet is carried in the cursor, with the path it had, until the round ends.
  Graph lists every parent of a changed item unless asked not to (`deltaExcludeParent`), so an item the round ends without placing has left the app folder — the user can move things out of it — and is reported deleted where it was.
  A deletion's old path is walked up the tree as it was, through any held item by the path *it* had, so a note deleted inside a folder still waiting on its new parent is reported where it was.
  Every deletion Graph lists is reported, even inside a folder also reported deleted: the engine matches it by id, and a filter by path cannot tell two folders that held the same old path within one round apart.
  At the end of a round anything else the tree can no longer place (what was inside a folder that was deleted or moved away) is dropped from it without being reported — something above it that was placed before moved or went, and that is reported.
  A file delta lists with no eTag is left out rather than thrown over, since one would stop every pull.
  A first scan that has items but none naming the app folder as parent is refused rather than reported as an empty folder, which would delete every clean note; the app folder's id is read afresh at the start of every scan.
  The cursor grows by a few hundred bytes per item in `syncState`, and every link read back from it must be on `graph.microsoft.com` before a token is sent to it.
  Outside delta, the path an item was asked for plus the name Graph returns gives its path.
- Graph lists the app folder itself in its delta; the adapter drops it (§7 guards the same in the engine).
- What a round reports, measured against a live personal account 2026-09-21, with a cursor held across each: **deleting a folder of notes** lists the folder and every note in it, each as a nameless tombstone.
  **Moving a subfolder of notes out of a folder and deleting that folder in one round** lists the moved subfolder at its new parent and the old parent as deleted — and says nothing about the notes inside the subfolder, which is the case the id tree exists for: their paths rebase from their parent's move, not from an entry of their own.
  **Renaming a folder while moving a note into it, in one round** lists the folder under its new name and the note under that folder, and the note ends up inside it.
  All three match what §7's "A round is one batch" assumes.
- Graph says to apply a round's changes after its last page, and the engine does (§7, "A round is one batch").
  Within a page every path is where the item is once the page is in, so the adapter lists the page's folders first, outermost first, and everything else after in the order it happened: a file listed ahead of the rename of the folder it lands in would otherwise be carried off by that rename.
- The two resync codes are told apart.
  Graph answers a dead token with `410` and one of them, and they disagree about whose copy may have lost something: `resyncChangesApplyDifferences` says "Replace any local items with the server's version (including deletes)", which is what a scan does anyway, while `resyncChangesUploadDifferences` says "Upload any local items that the service didn't return" — a server-side restore.
  So `CursorResetError` carries `uploadDifferences`, and the rescan it starts deletes nothing (§7, "A rescan that uploads").
  The code is read from `code`, from `innerError` and `innererror` alike, and from the `details` list, since the page says only "an error response containing one of the error codes below" and missing it is the direction that costs notes; anything unrecognised, `resyncRequired` included, falls back to today's reset and never to uploading.
  A folder moved *into* the app folder from elsewhere is reported alone; whether Graph lists what is inside it is one of the live checks.
- OAuth (`apps/api/src/oauth/onedrive.ts`): Authorization Code + PKCE against `login.microsoftonline.com/{MICROSOFT_TENANT}/oauth2/v2.0/{authorize,token}` as a confidential Web client, `response_mode=query`, `prompt=select_account` — without it Microsoft silently uses whatever account the browser is signed in to, which on a shared machine may be someone else's, and in storage-first that account then signs in as the user it is connected to.
- Account id: the ID token's **`sub`**, read from the token endpoint's response without a signature check (OIDC Core §3.1.3.7 allows it for a token received directly over TLS), and refused unless its `aud` is this client.
  Not `oid`, which needs the `profile` scope and is the same across every app a user signs in to; `sub` is pairwise — derived from the app, the user and the tenant they signed in through — which is all a connection needs, though an operator who changes `MICROSOFT_TENANT` to a tenant where their users are guests makes every returning user look new.
  Display name: the `email` claim, else "OneDrive"; it is unverified and a tenant admin can set it to anything, so it is stored with `email_verified = false` and must never link accounts (§6).
  So no Graph call is needed to name the connection.
  Claims are read at the code exchange only: the ID token a refresh returns is one Microsoft says not to rely on.
- Tokens: refresh tokens issued to the backend and **rotated on every refresh** — `/api/token` stores the new one; access tokens ~1h.
  Microsoft has no per-app revoke, so disconnecting deletes the row and answers `revoked: false` (§9).

### 5.3 Dropbox
- App type: **App folder** access.
  Scopes: `files.metadata.read files.metadata.write files.content.read files.content.write account_info.read`.
- Root: with App folder access, the API root *is* `/Apps/<AppName>`, where `<AppName>` is the app name set in the Dropbox App Console (immutable after creation — create it as `skysa-notes`).
  All paths are relative to it. ensureRoot just writes `.notesapp.json` at `/`.
- Files: `POST content.dropboxapi.com/2/files/upload` with `mode: { ".tag": "update", update: rev }` for conflict-safe overwrite (Dropbox returns a conflict error rather than auto-renaming when `autorename: false`).
  `mode: add` for create.
  **`strict_conflict: true` is required**: without it an `update` whose rev no longer matches still succeeds when the file has since been deleted, which is exactly the case the expected version exists to catch.
  A file that is not a note is the same `add`, its bytes as the body (2026-10-03, #187); one request carries up to 150 MiB (the `upload` route in Dropbox's API spec, `files.stone`), past which Dropbox wants an upload session the app's cap never needs.
- `Dropbox-API-Arg` is an HTTP header, so it must be ASCII: every character above printable ASCII has to be `\uXXXX`-escaped or a notebook named in a non-Latin script fails at the transport with an unhelpful 400.
- Errors: only a **409** carries an endpoint-specific `error_summary`; any other status may carry plaintext or an intermediary's HTML, so a tag is only ever read out of a 409, and by whole `/`-separated segment rather than substring.
  Otherwise a 503 whose body happens to say `conflict` would have the conflict rule copy the user's note aside over an outage.
  Match by segment, not equality — Dropbox says the tail carries detail that can change.
  A conflict does not include the current entry, so the adapter fetches it with `files/get_metadata` before raising `ConflictError`; that extra round trip happens only on the conflict path.
- `strict_conflict` also means Dropbox answers `conflict` for an `update` whose file has been **deleted**, where §4 calls for `NotFoundError`.
  The adapter tells them apart by looking the path up after a conflict: no entry plus an expected version is the deleted case.
  The engine's re-create-on-push path depends on it.
- `path_display` is nullable in Dropbox's spec.
  Defaulting a missing one to the empty string would produce an entry pointing at the app-folder **root**, which a later `delete` would act on, so the adapter refuses such metadata loudly instead.
- A cursor Dropbox cannot parse comes back as a plain **400**, not as `reset`.
  Both mean discard and re-scan; only one is typed, so the adapter maps a 400 from `list_folder/continue` to `CursorResetError` too.
  Without it a truncated cursor is retried forever.
- Folders have no `rev` and no `server_modified`.
  The adapter reports both as empty rather than inventing them, and nothing compares either for a folder.
- `create_folder_v2` answers with a `CreateFolderResult` whose `metadata` is declared as `FolderMetadata`, not as the `Metadata` union — so alone among the endpoints the adapter reads entries from, **it carries no `.tag`**, and a shared mapper that reads one calls every folder the app creates a file.
  `list_folder`, `get_metadata`, `move_v2` and `delete_v2` all tag what they return.
  Verified against a live account 2026-09-21, after the wire stub had tagged it anyway and hidden exactly that bug; `toFolderEntry` sets the kind from the endpoint rather than from the payload.
- `create_folder_v2` **creates missing parents itself**, in the one call (verified 2026-09-21: `a/missing/deep/child` under an empty `a` succeeded).
  So a `mkdir` whose parent another device removed does not fail, and the engine's `ensureRemoteFolder` retry is unreachable on Dropbox.
  Note the corollary: it silently re-creates a folder the user deleted elsewhere, rather than refusing.
- A `rev` is lowercase hex of at least 9 characters, and Dropbox validates that **shape before it compares the value**: a malformed one is a plain 400, not a conflict and not a missing file.
  Nothing in the engine can send one, since every rev it holds came from Dropbox, but a test that makes one up never reaches the behaviour it means to check — which is why the contract suite takes a per-provider `staleVersion`.
- Worse for a test than the shape rule, and the reason the suite now seeds and deletes a real file rather than inventing a version: an `update` **whose rev Dropbox has never issued** finds nothing to conflict against, so where the path is absent it simply **creates the file**, `strict_conflict: true` or not.
  Measured 2026-09-21: absent path + unknown rev → created; deleted path + unknown rev → created; deleted path + that file's real former rev → `conflict`, which is the case above and the only one the engine can produce; present path + non-matching rev → `conflict`.
- Version: `rev`.
- Changes: `files/list_folder` with `recursive: true` on first sync (returns cursor), then `files/list_folder/continue`.
  Optional later: `files/list_folder/longpoll` for near-instant sync while the tab is open.
- A round's entries are to be processed in order, each `DeletedMetadata` taking whatever is at its path then, and children included; a renamed folder comes back as its old path deleted and the new folder with everything in it listed again.
  Neither is on the API reference page; both are Dropbox staff answers ([processing order](https://www.dropboxforum.com/discussions/101000014/why-should-i-remove-the-entry-and-all-its-children-for-each-deletedmetadata-when/535415), [renamed folders](https://www.dropboxforum.com/t5/Dropbox-API-Support-Feedback/Handling-renamed-folders-in-list-folder-list-folder-continue/td-p/225665)).
  The wire stub replays what happened in order but reports a move as the new place alone, with no deletion of the old path; `randomRemote.test.ts` also runs the fake's feed told as Dropbox tells it — the old path deleted by path alone, then the new place, with and without the children listed again.
  An id-less deletion under a folder the round renames cannot be told apart from the rename's old path, so the engine asks the provider (§7).
  **Both confirmed against a live account 2026-09-21**: renaming `Work` to `Renamed` reported `Work/a.md` deleted, `Work/b.md` deleted, `Work` deleted, then `Renamed` and both its children — children before their parent on the way out, parent before its children on the way in.
- Paths: use `path_display`; Dropbox also gives an `id` (`id:...`) — store both, prefer id for identity.
- Tokens: `token_access_type=offline` → refresh token.
  Access tokens ~4h.
- Note: production apps need Dropbox "production" approval once past the dev user cap; App-folder apps have a light review.

### 5.4 WebDAV
*Deferred indefinitely (2026-09-17).*
WebDAV is not being built.
What follows is the design as planned, kept so it need not be worked out again if that changes; nothing in this repo implements it.

- Auth: URL + username + password (app password recommended).
  Stored encrypted on the backend; the client never sees them.
- Transport: **all WebDAV traffic goes through `/api/webdav/*`** because most servers don't emit CORS headers.
  The proxy forwards method/headers/body verbatim, injects Basic auth, restricts to the configured base URL, and streams bodies.
  Supported methods: `PROPFIND`, `GET`, `PUT`, `MKCOL`, `MOVE`, `DELETE`, `REPORT`.
- Root: the user supplies a base URL that *is* the app folder (e.g. `https://cloud.example.com/remote.php/dav/files/david/Notes/`).
  ensureRoot does `PROPFIND depth 0`, `MKCOL` if 404, then writes `.notesapp.json`.
- Files: `PUT` with `If-Match: <etag>` for updates, `If-None-Match: *` for creates.
  Version = `ETag` (strip weak prefix `W/` and normalize quotes).
- Changes: no universal delta.
  Strategy in order of preference:
  1. RFC 6578 `sync-collection` REPORT if the server advertises it (Nextcloud/ownCloud/SabreDAV do) — cursor is the `sync-token`.
  2. Fallback: full recursive `PROPFIND depth infinity` (or depth 1 walk if infinity is refused) diffed against the last snapshot.
     Cap frequency (e.g. on app open + every 5 min while active).
- Identity: path-based.
  After a `changes()` pass, re-link renamed files by reading frontmatter `id` of any "new" file whose size/etag suggests it might be a moved note.
  Accept that renames done outside the app look like delete+create in the worst case.

---

## 6. Backend

Hono app in `apps/api`, deployed to Cloudflare Workers with `wrangler`.
Keep it boring.

- Runtime: Workers only.
  Use Web Crypto (`crypto.subtle`) for AES-GCM, `fetch` for provider calls, no Node built-ins.
  `wrangler dev` locally (Miniflare) with a local D1.
- Database: D1 via `drizzle-orm/d1`, migrations with `drizzle-kit generate` + `wrangler d1 migrations apply`.
  Same SQLite dialect locally and in prod.
- Secrets: provider client ids/secrets and `SECRETS_KEY` via `wrangler secret put`; never in `wrangler.toml`.
- Static SPA served from the same Worker via `[assets]` in `wrangler.toml` (SPA fallback to `index.html`), so `/api/*` and the app share an origin and cookies are first-party.
- **Composition root:** `apps/api` exports `createApp({ entitlements, rateLimiter, relay, fetch, providerTimeoutMs, config })` as a library; its own `src/worker.ts` calls it with the defaults.
  An operator who needs different behavior writes their own Worker entry that imports `createApp` and passes their own implementations, instead of forking.
  Nothing in `apps/api` reads env directly except `worker.ts`.
- Cookies with `hono/cookie` — two, the short-lived OAuth flow cookie and the callback's answer to it (see "Storage OAuth, as built"); there are no sessions (see "Per-connection credentials").
  Request validation with `zod`.
  (`@hono/zod-validator` was declared up front and never used — the routes validate with `zod` directly — so it was removed.
  Re-add it when a route actually wants the middleware; the removal is not a decision against it.)
- **Entitlement seam:** every route that mints a token or proxies WebDAV calls `entitlements.check({ connectionId, provider, accountId, displayName })` from an `EntitlementProvider` interface in `core`.
  The repo ships `AlwaysAllowed`.
  Operators of a shared instance can substitute their own (an allowlist of accounts, for example) through `createApp`; no such policy logic lives in the repo.
  *Revised in Phase 7:* it took a `userId` until connections stopped aggregating under a user, and an account is what an operator's rule can actually be written about.
  **The OAuth callback asks as well**, once it knows which account it is and before it stores anything: asked only at `/token`, a refused account still left its refresh token sealed in D1, unusable and unreachable, and its owner learned of the refusal when sync failed.
  `connectionId` is absent from the subject when the account has no row yet.
  A refusal stores nothing — no connection, and no grant, whose hash would otherwise be spent — withdraws the consent just given where the provider has a revoke call, and sends the user back with `?connect=refused`; the operator's `reason` is not carried, since free text in a URL is text anyone can put in a link (its `code` is, below).
  An account that already has a connection keeps it as it was, and `/token` goes on refusing it — and for that account nothing is revoked, because Google's revoke takes every token the user has granted the app, the one sealed in its row included, and a refusal can be a lapse the operator lifts later.
  A seam that throws has not said yes: `?connect=failed`, nothing stored.
  `/token` still asks, because what is allowed today can lapse.
- **Refusal codes and the connect gate (2026-09-24, issue #131).**
  A refusal met only after the provider's consent screen, worded the same whatever the reason and offering nothing to do next, was the whole of what a restricted instance could say.
  Two additions change that, and both come through the entitlement seam.
  - **Codes.**
    `EntitlementDecision` gains an optional `code` from a fixed list, `ENTITLEMENT_CODES` in `core`: `not_allowed`, `lapsed` and `limit_reached`.
    The callback carries it as `?connect=refused&code=…`, and `/token` returns it beside `reason`.
    A code outside the list is dropped on the way out (`knownCode`), and the refusal then reads as one with no code.
    A value from a closed set says nothing a link-maker can choose, which is what kept `reason` out of the URL.
    The app words the refused toast and the storage panel's `not_entitled` line by the code, and puts the operator's `reason` under the panel's line.
  - **The gate.**
    `EntitlementProvider` gains an optional `gate`: a plain-text message and one `https:` link.
    `/api/config` serves it as `connectGate`, and the app shows it where the provider buttons are.
    It lives on the seam and not in env, because a gate means nothing without a policy of the operator's, and that policy already needs its own Worker entry.
    A gate on an instance that lets everyone in would turn people away from an open door.
    `createApp` checks it with zod when the app is built and throws on anything else, so a bad gate is a boot failure (`server_misconfigured`), as a bad env is, rather than a broken link.
    The client checks it again and drops a gate that does not parse, keeping the rest of the config.
    Its URL becomes a link on the page, and only `https:` is followed, which is the check #89 asks for on the connect flow's URL.
    Both sides serve the URL normalized: with a custom protocol rule zod accepts `https:example.com`, which an `href` would resolve into a path inside the app, and normalized it is `https://example.com/`.
    The refused toast waits for the config to answer or fail before it appears, so its link is part of the alert from the start and not added a moment later.
  - **Who sees the gate.**
    A device holding a live connection on the instance sees the provider buttons, with the gate as a line above them: its account was let in at least once.
    Any other device, including one holding only a detached source, sees the gate plus "Already have access?
    Connect storage", which shows the buttons.
    Showing them grants nothing, because the policy still decides at the callback.
    A gate whose code is `required` is the exception to both: every device sees its code field until a code is accepted ("Connect codes", below).
  - **The issue's two open questions.**
    The live-connection rule above answers the first.
    For the second, the gate is a `createApp` option and not env, and it is static: a gate that varies per request, for example by locale, would be a later change to a function-valued field.
    Reconnecting an account the device already holds is not gated.
- **Connect codes (2026-09-28, issue #139).**
  Issue #131 left one thing out: passing anything from the gate back into the connect flow, "such as a claim code", was to be its own issue if anyone needed it.
  An operator whose policy turns on something other than the storage account needs it: a code their own page sends to someone who has paid, or an invite.
  Before a connect the server knows nothing about who is connecting, and after it the server knows only the account.
  - **The seam.**
    `ConnectGate` gains an optional `connectCode: { label, required? }`, checked with the rest of the gate (a label of 1 to 40 characters).
    Whatever is typed goes with `/start` as `connectCode`: trimmed, at most `MAX_CONNECT_CODE` (64, in `core`; 256 since the held value below) characters, and printable.
    A blank one counts as none, and anything else is `invalid_request`.
    The code rides to the callback in the signed flow cookie beside the verifier, and the policy is handed it as a second argument: `check(subject, { connectCode })`.
  - **Checked as it is used (2026-09-29, issue #146).**
    Until then the code was checked only at the callback.
    "Use code" asked the server nothing, so any code at all looked accepted until the provider sent the person back past a consent screen.
    A gate that asks for a code now needs `EntitlementProvider.checkCode(code)`, which `createApp` insists on, and the app asks it through `POST /api/connect-code` as the code is used.
    The answer is `{ accepted: true, expiresIn }`, the seconds the app should keep the code (at most a day, `MAX_CODE_HOLD_SECONDS`; a year since the held value below), or `{ accepted: false, reason? }`, plain text of at most `MAX_CODE_REASON` (200) characters, shown under the field.
    Seconds from now rather than a time, so a device whose clock is wrong keeps it as long as was meant.
    The server holds the answer to that shape: a reason that is not plain text is dropped and the refusal kept, a hold longer than the most is cut to it, and anything else, or a throw, is a 500 that passes nothing on.
    It is advice, not the decision: the callback still asks `check` with the code, so a code that runs out between the two is refused there.
    An answer to "is this a code" is worth guessing at, so the route is same-origin like `/start` and goes through the rate limiter (`connect-code:<ip>`) before the policy is asked.
    How many guesses that leaves is the operator's to size against how many codes it has live and for how long.
  - **Two steps.**
    The gate and the buttons are two steps, one open at a time.
    An accepted code opens the buttons and folds the gate to a line naming the code (or, for a value held in its place, saying it was accepted; below) and when it stops being good, and its "Change" opens the gate again and closes the buttons, so only the next thing to do is on screen.
    When the hold ends, with the menu open or while the app was closed, the gate asks again with the field empty.
    With `required`, a code is the only way to the buttons, for every device, one already syncing here included.
    Without it, "Already have access?" shows them to someone the policy knows already, and a device with an account syncing here starts on the buttons, with "Have a code?
    Enter it" as the line, since it may be adding an account the operator has not seen.
    A blank code cannot be used.
  - **Decided only at the callback.**
    `/token` and the WebDAV proxy ask with no second argument.
    A policy that accepts a code decides as the account connects and remembers the answer itself, keyed on the account, which remains the only subject there is.
    The code is not a credential.
    The device sends it only to be checked and with a connect, never with `/token`, and the server keeps it only for the life of the flow cookie.
    That is why it does not reopen "No sign-in separate from storage" below: it is said to connect, and after that the storage account is the identity, as before.
  - **Kept for as long as the policy says.**
    The app holds an accepted code in `localStorage` beside the time the policy said it stops being good, so it survives the round trip through the consent screen and a closed tab or installed app, and one code can connect several accounts.
    A read after that time finds nothing and clears it.
    It was `sessionStorage` until the policy could say how long: a code kept for later visits would have outlived what it meant, and the end the policy gives is what keeps that from happening now.
    It is none of the three kinds of secret: the operator issued it to the person typing it, and it is worth only what their policy decides.
    Where storage is refused, the app holds it in memory, which is enough for the connect it was accepted for.
  - **A value held in place of the code (2026-10-05, issue #218).**
    A code good for minutes, typed once per sitting, made an operator who sells access email a new one each time anyone connected anything: a second provider a week later, a new browser, the same account again after the last device let it go.
    The operator wanted a code to prove the address once per device, and then not again.
    So an accepted answer may carry `hold`, a value the app keeps and sends in place of what was typed — with the connect, and to `checkCode` — for `expiresIn`, which may now run to a year.
    What it is, and what it proves, is the policy's: a pass it sealed for this device, say, good while a subscription lasts.
    The server holds `hold` to what a code is, since it travels as one: trimmed, printable, at most `MAX_CONNECT_CODE`, which went from 64 to 256 characters to make room for something sealed (the flow cookie is about 2.1 KB at worst, measured with the longest return path, against the 4 KB a browser keeps).
    One that is not fails the answer with a 500, rather than being dropped, since dropping it would keep the typed code the policy chose not to have kept.
    The gate never shows a held value: its folded line says the code was accepted on this device and until when, and "Change" opens an empty field.
    And the app asks about a held value again as it loads, where the gate asks for a code: the answer replaces what is held, which is how a policy that answers with a fresh `hold` keeps a pass alive for as long as the device is used; a refusal lets it go, so a pass the policy stopped taking — the subscription ended — closes the gate before any consent screen rather than after one; no answer, or a limit reached, keeps it, and the callback decides as it always did.
    It asks at most once an hour since the policy last answered, because each asking spends one of the guesses `connect-code:<ip>` allows, which everyone behind one carrier's or office's address shares, and someone typing a fresh code must not find them spent; and it does not ask about a typed code at all, which is good for minutes and gains nothing from it.
    A refused connect does not drop a held value, as it drops a typed code: nothing was typed, and the no may be about the account.
    The app asks about it at once instead, and lets it go only if the policy says so.
    A fresh `hold` must not end the one it replaces, since two tabs loading together, or an answer lost on the way, can leave the earlier one held.
    An app still on a version before this one refuses any answer that keeps a code longer than a day, so an operator should give long holds only once its app has been updated.
    A held value is a bearer to the operator's policy: whoever copies it out of the browser can connect what the policy would let this device connect, until the policy stops taking it.
    It is still none of the three kinds of secret, since it reaches no storage and no credential, but it shares the third kind's exposure in `localStorage`, and what keeps it is the same `script-src 'self'`.
    It is still said only to connect, and never with `/token`, so it does not reopen "No sign-in separate from storage" any more than the code did.
  - **The gate's link opens in this window, and the way back is `?enter=code` (2026-10-02).**
    It opened a new tab, so the app would still be there to come back to.
    In an app installed on a phone a new tab is a second window, and the only way back from it to the code field was to close the app and open it again.
    All three places the link appears — the `+` menu's gate, the storage panel's not-entitled line and the refused toast — now open it in the same window, as the provider buttons go to the provider.
    The operator's page links back to the app with `?enter=code`, which opens the way to connect at the gate's code field: the `+` menu in a wide window, or the sources dropdown and its `+` in a compact one, with focus in the field, even with a code already held.
    It is read once and removed, as `connect` is (`routes/search.ts`), and waits for the config to say there is anything to offer.
    An operator's page that does not link back loses nothing that was there: Back returns to the app, and the code is typed into the `+` menu as before.
  - **A refused code.**
    A plain no (`not_allowed`, or no code) to a connect made while a code was held reads "The code you entered was not accepted or has expired", and the code is dropped, so the gate is back on an empty field.
    `lapsed` and `limit_reached` are about the account or the instance, not the code, and are worded as before, with the code kept.
  - **A yes is not a stored connection.**
    The callback can still fail after the policy says yes, and then nothing is stored.
    A policy that records something on a yes, such as linking the account to the code, must let the same account connect again and be asked again.
- **Rate-limit seam:** `createApp({ rateLimiter })`, defaulting to `neverLimited`, consulted by `POST /api/auth/connect/:provider/start`, the callback, and `POST /api/token` — the three endpoints that spend an outbound provider call — and by `POST /api/connect-code`, which spends none but answers a question worth guessing at.
  Also by the change relay's ticket and upgrade (`relay-ticket:<connectionId>`, `relay:<connectionId>`), which spend none either but would otherwise let one device open sockets without limit.
  A seam and not a Cloudflare binding, for the same reason as the entitlement one: a binding would be deployment-specific code in a repo that forbids it.
- **Provider enablement** (`ENABLED_PROVIDERS` env, default `dropbox` — only what is implemented; each OAuth provider listed must have its credentials or the app refuses to boot).
  Which settings those are is said once, in `OAUTH_ENV` in `apps/api/src/env.ts`, keyed by the flows in `oauth/providers.ts`, so a provider added to one and not the other does not compile; the schema, the boot check and the credentials `createApp` is handed all read it (#450).
  `webdav` is accepted and needs no credentials, but WebDAV is deferred (§5.4): nothing is mounted for it, `/api/config` does not offer it, and the Worker logs a warning at boot while it is listed.
  `WEBDAV_ALLOW_PRIVATE` is likewise read, does nothing, and warns.
  Refusing either would break a deployment that has it set, so both stay until #118's breaking change (decided 2026-10-25, #450).
  If it is ever built, its routes and proxy are mounted only when `webdav` is listed.
- **No sign-in separate from storage.**
  Decided 2026-09-18, and it closes what used to be two modes behind an `AUTH_MODE` env.
  Identity and data are coupled: a connection is reached by the credential the device that made it holds, and nothing anywhere aggregates connections under a subject.
  A person with Dropbox and Google Drive connected has two silos, and the server cannot tell they are one person — which is the property, not a limitation to be fixed later.

  What this closes, so it is not re-opened by accident: no `identities` table, no `IdentityProvider` adapters, no Google/Microsoft sign-in, no merge-by-verified-email, no account linking, no magic link, and no `arctic` dependency — whose deprecation (July 2026) had been an open question since 2026-09-14 and is now moot rather than decided.
  §14 keeps the reasoning and what it would have cost.

  The gain is that a whole class of question stops needing an answer here: which of two identities a grant belongs to, what a verified email is worth, what happens when a linked provider is unlinked, and who may see a connection someone else made.
  A shared instance is still possible — that is what the entitlement seam is for — it just gates on the storage account rather than on a user the server invented.

  **Still in the tree, and going:** `AUTH_MODE` (an env var with one legal value), the `users` and `identities` tables (`apps/api/src/db/schema.ts`, unread by any code), and the client's `account-first` branch in the storage panel (`components/account/NotConnected.tsx`).
  They are left standing in the change that made this decision because dropping the two tables is a hand-written D1 migration and this is a documentation change; issue #118 tracks them.

- **One OAuth flow per provider, and it is for storage.**
  `/auth/connect/:provider` requests storage scopes only.
  There is no `/auth/login/:provider` and none is coming.
  *From Phase 4:* the storage request does **not** pass `include_granted_scopes` (see "Storage OAuth, as built").
  One consequence of Google's model is worth keeping written down even now that only one flow exists: Google revokes every grant to a project at once, so disconnecting storage revokes the whole project's access for that user — there is simply nothing else left for it to take down.
- WebDAV proxy: stream request/response bodies straight through (`c.req.raw.body` → upstream `fetch` → return `Response`); enforce a 30 s upstream timeout with `AbortSignal.timeout` and a 20 MB cap regardless of Cloudflare plan limits.

### Storage OAuth, as built (Phase 2)

Dropbox is the first storage flow and the shape the others follow.

- **Hand-rolled.**
  The storage flows are Authorization Code + PKCE and about forty lines each, so they install no OAuth dependency at all.
  (`arctic` was once planned for sign-in, was deprecated by its author in July 2026, and is moot now that there is no sign-in — see "No sign-in separate from storage".)
- **The PKCE verifier and `state` ride in a short-lived signed cookie** (`skysa_flow`, 10 minutes, `httpOnly`, `sameSite=lax`), not a table.
  §9 wants `state` bound to the browser that started the flow, which is what a cookie *is*; a table would need a sweep job and a KV binding neither of which exists.
  The payload is signed because an attacker who could rewrite it could otherwise substitute their own `state` and complete a flow the user never began.
- **A callback asked for again is answered the same way (2026-09-30, issue #149).**
  The callback can be answered only once: reading it clears the flow cookie, and the provider's authorization code is spent.
  But a browser can ask for it twice.
  Chrome's Safe Browsing check runs beside the request, not before it, so its warning page can cover a callback the server has already answered, and going on past the warning asks again; so do a reload and the back button.
  The second asking found no flow and was told `flow_expired` in raw JSON, over a connection the first had stored.
  Found on the hosted service, where Chrome put its warning over a OneDrive callback.
  Now every answer the callback gives after checking `state` is also written to a second signed cookie, `skysa_flow_answer` (five minutes, `httpOnly`, `sameSite=lax`): the flow's `state` and the path it sent the browser to, `?connect=` outcome and all.
  A callback carrying that `state` is sent to the same path, exchanges nothing and touches no cookie, so a third asking is answered too and a flow started since is left to finish.
  Nothing in it is secret; it is signed because a redirect read from a cookie anyone could write would be an open one, and only a path in this app is taken from it.
  There is one answer at a time, as there is one flow.
- **A callback with no flow goes back to the app.**
  No flow cookie, a `state` that does not match, a flow older than its ten minutes, or an answer older than its five: the server cannot tell these from a forged link, and exchanges nothing.
  It is still a page a browser is on, so it redirects to `/?connect=expired`, and the app says that connecting did not finish and to connect again if the storage is not connected.
  It does not guess which: the storage tabs show what is connected.
- **No failure on the callback answers in JSON (2026-10-26, issue #451).**
  Three still did, to a browser that was navigating: a provider the deployment does not offer, or has turned off since the flow started (`unsupported_provider`, `provider_not_configured`); a callback carrying neither a `code` nor an `error`; and the callback's rate limit.
  Each now redirects to the flow's `returnTo` with `?connect=failed`, and is logged, as a failed exchange is, since to the user it looks like any failure.
  All are checked after the `state` check, so a callback with no flow is still `expired`, nothing reaches the log without a flow this browser started, and asking again is told the same.
  `/start` is a fetch from the app and still answers these in JSON.
- **`sameSite=lax`, not `strict`**, on both cookies: the callback is a top-level navigation arriving from the provider, and `strict` would drop the cookie exactly when it is needed.
  `secure` is derived from `APP_ORIGIN` so plain-HTTP local development still works.
- **The HMAC key is derived from `SECRETS_KEY` through HKDF**, not imported from the same bytes that do AES-GCM.
  One key, two algorithms, is how key-separation bugs start.
- **`token_access_type=offline`**, and a grant that comes back without a refresh token is a 502 rather than a stored connection that would stop working in four hours with no way to recover.
- **A unique index on `connections(user_id, provider)`** (migration `0001_connection_per_provider`) turns reconnecting into an `ON CONFLICT DO UPDATE` instead of a read-then-write race between two tabs.
  It also makes §12.3 a constraint rather than a UI convention.
  Reconnecting clears `root_id`: a new grant can point at a different account.
- **`SECRETS_KEY` must decode to exactly 32 bytes**, checked at boot.
  It was `.min(1)`, which meant an operator mistake surfaced the first time somebody tried to connect an account.
  (The existing test fixture turned out to decode to 30 bytes.)
- **`returnTo` is confined to this app.**
  Anything not starting with a single `/` becomes `/`.
- **`/api/token` decrypts the refresh token and returns only the access token.**
  It is the first `entitlements.check(…)` call site (§6, "Entitlement seam"), and it re-seals a rotated refresh token so the connection survives a rotation Dropbox is allowed to do.
- **Disconnecting revokes best-effort and deletes regardless.**
  A user who asked to disconnect must not be left connected because the provider was down.
  `revoked: false` says only that the grant may still be live — the revoke failed, or the provider (Microsoft) has none.
- **One provider per user (§12.3), enforced once a second provider exists (Phase 3).**
  A signed-in user whose storage is connected at one provider is sent back with `connect=occupied` when they start or finish connecting another, and has to disconnect first.
  In storage-first any connected account signs in as its user, so a Dropbox and a OneDrive connection side by side would make whoever holds the OneDrive account able to mint the Dropbox tokens.
  Reconnecting at the same provider replaces, as before.
  Two consent flows for the same user that overlap — in two tabs, or on two devices, one of which stays signed in after the other disconnected the last connection — can both pass the check; Phase 7's multiple connections have to answer that properly (a unique index, or connections that do not sign anyone in).
- **Only a refused grant asks the user to reconnect.**
  `invalid_grant` and `interaction_required` from a token endpoint are `reauthorize_required`; anything else — `invalid_client` once a client secret expires, `temporarily_unavailable`, a 5xx, a timeout — is logged by its code alone (`apps/api/src/log.ts`) and answered `502 provider_unavailable`, which the client retries.
  Told to reconnect over an expired secret, every user would go through a flow that fails the same way, and nothing would tell the operator.
  A failed code exchange is logged the same way.
- **Google (Phase 4, `apps/api/src/oauth/gdrive.ts`)** follows the Microsoft shape, with Google's differences:
  - The request carries `access_type=offline` (no refresh token otherwise) and `prompt=consent select_account`.
    Consent is asked for again because a reconnect gets no refresh token without it; `select_account` is there for the shared-machine reason §5.2 gives.
    There is no `include_granted_scopes`, so the consent screen lists exactly the storage scopes.
    Revocation is per project either way (§6's two-flows bullet).
  - **Granular consent:** Google lets the user untick Drive and still completes the grant.
    The exchange checks the response's `scope` for `drive.file`.
    If it is missing, nothing is stored and the user is sent back with `connect=partial` (a `ScopeNotGrantedError`, which no token endpoint's error code can imitate), which the web app answers with "leave that permission ticked".
    This is not logged, since it is the user's choice.
    Nothing is revoked either: Google revokes per project, so a revoke here would also end the same user's working connection on another device.
  - The account id is the ID token's `sub`, read and `aud`-checked as for Microsoft.
    Unlike Microsoft's, Google's `sub` is the same for every app the account signs in to.
    The display name is `email`, else "Google Drive", and is stored unverified whatever `email_verified` says (§6).
  - A refresh returns no refresh token, so `/api/token` keeps the stored one.
  - Disconnecting revokes: `POST oauth2.googleapis.com/revoke` with the freshly refreshed access token.
    That revokes every grant the user gave the Cloud project, which is why `docs/google-oauth.md` asks for a project per deployment.
  - A Workspace admin restricting Drive answers `admin_policy_enforced`, which is `provider_unavailable`, not `reauthorize_required`: reconnecting would be refused the same way.
  - While the Cloud project is in Testing, refresh tokens expire after 7 days.
    That arrives as `invalid_grant` → `reauthorize_required`, so users reconnect weekly.
    `docs/google-oauth.md` walks an operator through the project, the client and leaving Testing.

**Test harness.**
`@cloudflare/vitest-pool-workers` — which would give the tests Miniflare's real D1 — still peers on `vitest ^4.1.0` against this workspace's 5, so it cannot be installed.
The fallback is a ~120-line D1 shim over Node 22's built-in `node:sqlite` (`apps/api/tests/d1.ts`), which keeps the real `drizzle-orm/d1` driver, the real schema and the real migration files; only the process hosting SQLite differs.
No new dependency.
Swap it for the pool once that supports Vitest 5.

**Deliberately not done:** AES-GCM is used without additional authenticated data.
Binding the connection id as AAD would stop a ciphertext copied between rows from decrypting, but an attacker who can write to `connections` has already lost the user the game.
Recorded here rather than done, because the seal/open signature is cheaper to change now than after WebDAV credentials use it too.

### Per-connection credentials (Phase 7)

Until Phase 7 a user held **at most one connection**, because in `storage-first` any connected account signed you in as that user: two connections under one user would cross-authorise, and whoever held the OneDrive account would get tokens for the Dropbox one.
Phase 7 removes the premise rather than the guard.
**There is no shared user.**
Each connected storage account is its own silo — auth and data coupled — and the device switches between the ones it holds.

What proves a device's right to a connection is a credential it generated, not a session cookie:

1. The PWA generates 32 random bytes, **awaits** an IndexedDB write of them, and sends `SHA-256` of `sk1_<bytes>` to `POST /api/auth/connect/:provider/start` with `returnTo`.
   The hash rides in the existing signed `__Host-skysa_flow` cookie beside `state` and the PKCE verifier.
2. The callback commits the connection **and** its grant in one `db.batch`, then redirects as before.
   The batch being one transaction is load-bearing for the racing-callback recovery, and that in turn assumes D1 enforces foreign keys within it — documented, but proven here only against the `node:sqlite` shim.
   If it did not, the loser of a race would commit a grant pointing at an id that does not exist, the user would see `connect=ok`, and the device would be 401 for ever with its hash spent.
   The *security* property does not depend on it: a grant pointing at a dead id reads as claimed and authorises nothing.
3. The PWA presents `Authorization: Bearer sk1_…` from then on.

The plaintext credential never enters a URL, a fragment, history, a `Set-Cookie`, a response body, a Worker log, or the database.
"The API never holds the plaintext" is literally true rather than true-except-in-transit — which is what deleted the exchange endpoint, the pending-code table, its TTL and sweep, the double-claim race, and the window where a connection was committed but its credential was never collected.

Each decision, with the reason it would otherwise be got wrong later:

- **`/start` is a same-origin `POST`.**
  The hash is caller-supplied, so a `GET` would be a session-fixation hole: a link carrying the attacker's hash, consented to by the victim, hands the attacker a live credential to the victim's storage.
  `hono/csrf` does not cover JSON bodies (it matches only form and text content types, leaning on CORS preflight), so the route checks `Origin === appOrigin || Sec-Fetch-Site: same-origin` itself and keeps `csrf()` as defence in depth.
- **Lookup is by hash, not `<id>.<secret>`.**
  An id-then-compare needs a constant-time comparison, and `crypto.subtle.timingSafeEqual` is a Workers extension **Node's webcrypto lacks** — and the suite runs on Node against a `node:sqlite` D1 shim.
  A unique index on the hash sidesteps a hand-rolled comparison tested under the wrong crypto.
  Idle expiry is part of the same query, so an expired grant is indistinguishable from an unknown one.
- **A hash is claimable once, ever, and `grants` rows are therefore never deleted.**
  Revoking a device, disconnecting the account (the foreign key is `on delete set null`) and the cap's prune all null `connection_id` and leave the row; `grantHolder` treats a null as revoked.
  The row that stays is a tombstone, and the unique index over `secret_hash` is what it holds.
  "Once, ever" means once per continuous life of the database, which is not quite unconditional: D1's Time Travel restores a point in time, and the credentials themselves live in each device's IndexedDB and are not rolled back with it.
  A restore therefore un-spends every hash issued since the restore point while the devices holding those credentials still hold them.
  Nothing in code can see that; it belongs with the operator, alongside the fact that a deployment reset invalidates every credential at once.
  Review caught this as a live hole rather than a precaution.
  An earlier draft used a plain insert and reasoned that a repeated hash would fail — true only while the row exists.
  A hash leaked from a database dump mints nothing on its own, but once its grant is gone it is claimable again, and the attacker needs nothing of the user's: they start a flow with the victim's hash, consent with storage of *their own*, and the row is re-pointed.
  The victim's device — offline throughout, holding the plaintext, told nothing — comes back, is answered 200, and syncs the user's notes into a stranger's Drive.
  All three ways a grant used to disappear reached it, and the prune is not even user-initiated.
  Tested as the attack, once per path (`connect.test.ts`, "a hash is spent once, however its grant stopped being live").
- **A connection no live device reaches is deleted, not kept.**
  Left behind it is a sealed, live refresh token that nothing can use and nothing can revoke — disconnecting takes a credential.
  So revoking the last live grant (only a device signing itself out can, since a caller revoking another is itself live) disconnects.
  The grant is nulled and the row deleted in one batch, which D1 runs as one transaction (`revokeGrant` in `apps/api/src/db/connections.ts`), by a statement that asks and deletes together (`DELETE … WHERE NOT EXISTS` a live grant), and only then is the grant withdrawn at the provider, best-effort, from the row as it was read: asked first and deleted after the provider's calls, a device whose callback committed in between had the row taken from under it, and a request cut off during those calls left exactly the orphan this removes.
  *Revised 2026-10-28:* the nulling and the delete were two statements until then, and a request cut off between them left that orphan too.
  *Revised 2026-10-02:* this is now what the panel's Disconnect does.
  It used to call `DELETE /api/connection`, which took the account from every device holding it: disconnecting on a phone stopped the laptop syncing too, though nothing on the laptop had been asked.
  Disconnect now signs out the device it is pressed on and no other (`signOut` in `apps/web/src/api/client.ts`: `GET /api/connection` for this device's `grantId`, then `DELETE` that grant), so only the last device out disconnects the account and withdraws its access at the provider.
  The question says which this will be before it is answered, from the device list's own count (live grants other than this one; `stillSignedIn`): "The other device connected to it stays connected and keeps syncing", or "This is the only device connected to it, so the account is disconnected too", or both where the server could not be asked.
  Where to withdraw OneDrive's access by hand is said only when the account may be going.
  Cancelling a first import signs out the same way, since the account being imported may be one another device was already syncing.
  A device the user believes is stolen is signed out from the device list (Remove), which never takes the last.
  A grant idle past its expiry cannot authenticate and does not count as live.
  Connecting the account again makes a new row, and the device knows its notes by the account's id, not the row's.
  And the device retires what it replaces: "Connect again" mints a new credential, so once that is kept the device signs out the one it held for the same connection (`claimConnection`), rather than leaving it in the device list as a live key for 180 days.
  Best effort — a credential already revoked has nothing to retire.
  What is still not covered, and these are the orphans that do happen: a device that clears its site data while it is the only one, and an account whose every device idles out.
  The grants expire, but the row stays; there is no sweep, because a Worker has nowhere to run one without a cron trigger every self-hoster would then carry.
- **A device reconnecting with the credential it already holds succeeds.**
  The same draft refused every repeated hash, which wedged the ordinary case: nothing tells a device to mint a fresh credential before connecting again, and the duplicate rolled back the whole batch — new refresh token included — identically on the retry.
  A hash whose row already points at *this* connection is that device; only a hash bound elsewhere, or spent, fails the connect.
- **`GET /connections` is gone, replaced by singular `GET /api/connection`.**
  A one-element array invites the aggregation model straight back, and the client that unbinds on an empty list would keep "working" with the wrong meaning. 404 (or 401 for a revoked credential) means *this connection is gone*; a 5xx or a network failure means nothing.
- **`connections.account_id` is `NOT NULL`** so `(provider, account_id)` can be the upsert target: SQLite NULLs do not conflict, and a nullable target would insert a duplicate on every reconnect forever.
- **A grant cap per connection** (20, pruned inside the same batch), because every live grant is a key to the same storage.
  Eviction is by `last_used_at`, not `created_at`: pruning by age logs out the device someone actually relies on and keeps the ones they have stopped using, and going by use also means a grant already past its idle expiry is evicted before a live one instead of holding a slot it can no longer use.
- **Migrations `0004`/`0005` are hand-written.**
  `drizzle-kit`'s SQLite table rebuild emits `PRAGMA foreign_keys=OFF`, which D1 rejects and the test shim silently tolerates — green in tests, wedged on `wrangler d1 migrations apply`.
  A rebuild written by hand avoids the pragma but not the `DROP TABLE` + `RENAME` pair in the middle, whose partial state no re-run can recover from; so the new shape gets a new table name (`storage_connections`), `0004` never drops the table it reads, and dropping the old one is `0005`'s single statement.
  Every device reconnects after this: sessions carried that right before, and a grant can only be created by the OAuth callback.
- **`sessions` goes; `users` and `identities` stayed**, annotated at the time as the account-first mode's only callers.
  That mode was dropped on 2026-09-18, so the two tables now have no caller at all and are owed a migration (issue #118).
- This retires `holdsAnotherProvider`, `session_mismatch`, `claimedBy`, the compensating delete, and the `conflict`/`signin`/`occupied` outcomes — not by relocating them but by removing what made them necessary.

**The device half (`apps/web`).**
The store layer was already keyed by connection; what was singular was everything that chose *which* one.

- **The chosen source is a persisted preference** (`sync.activeConnection`), not `syncState.first()`.
  Every reader and writer in `store/` asks `activeConnectionId`, and the writers ask **inside their own transaction** — asked outside, a note created while an account is being connected can be written under the connection its rows have just been moved off, where nothing shows or syncs it.
  The panel and the scheduler follow the same preference, so the notes on screen and the notes being synced are always one account's.
- **Connecting a source moves nothing but the device's own rows.**
  `moveRowsTo` takes the connection to move *from* (`LOCAL_CONNECTION_ID` for a first connect, a detached source of the same account for a reconnect — and on the way out only what the user has been shown and has asked for by name, see "Letting a source go" below: a disconnect on its own moves no row anywhere).
  It used to move every row not already under the target, which was the same thing while a device could hold one source and is now the bug: connecting a second account would carry the first's notes into a stranger's storage and say nothing.
- **Which account a connection is to lives on its `syncState` row, and nowhere else.**
  There was a device-wide preference beside it (`sync.notesAccount`) for whose the device's *own* notes were, because a disconnect moved a source's rows into the device's own pile and a reconnect had to know whether to resume them.
  No disconnect fills that pile now, so what is in it was written before anything was connected and is no account's; the preference, its `MIXED_ACCOUNTS` value and the label read from it are deleted rather than kept for a case that cannot arise.
  Resume is decided by the row the kept notes are still under: `bindingMode` asks whether a *detached* source has this account, and answers with which.
  *Added 2026-10-02:* a source still bound to the same account under another connection id is let go first (`supersede` in `claimConnection`, as `revoked`), so that it is detached by the time `bindingMode` asks.
  The server keeps one connection per account, so another id is a connection it has deleted, but nothing on the device learns that until the source is asked about, and "Connect again" is offered as soon as a sync is refused: a device whose account was disconnected elsewhere, connected again, showed the account twice ("Google Drive" and "Google Drive 2") until the old one was next opened.
- **Nothing is asked at bind.**
  The "these notes belong to another account" prompt (`other-account`, `adoptAccount`, `needsAsking`) went with the pile it was about.
  The device's own rows are no account's, so copying them into the first source connected is what clicking Connect meant.
  A detached source of a *different* account is not absorbed by a bind at all: it stays a source of its own, in the list, saying what it holds.
  **The question is asked before the connect instead (2026-09-23).**
  Clicking Connect meant copying them only if the user knew it would, and nothing on the way said so.
  So pressing a provider while the pile holds a note or a notebook first says how many will move and into which provider, with Cancel — which keeps them on this device only — focused (`ConnectButton`, `pileContents`).
  It is asked before the credential is written or the server is asked, so a cancel leaves nothing anywhere; and on every connect, not only the first, since whatever the pile holds goes into whichever account is next.
  The bind itself still asks nothing.
- **A source's first import says how it is going, holds the app if it is the first, and can be cancelled (2026-09-23).**
  A bind of a source the device has not seen (no row for it, nothing resumed) marks its row `importing` (`{ lock, returnTo }`): `lock` when no other live source exists, and `returnTo` the source that was in front.
  **The pile is copied in and kept, untouched, until the import is through** — it used to be deleted in the bind's own transaction, which left Cancel nothing to go back to.
  While any source is importing, the pile is hidden from the source bar and `pileContents` counts nothing, so it is neither shown twice nor offered to a second connect; a second bind copies nothing more.
  The import finishes (`finishImport`) when the scheduler's first pull is `ok` and the push after it is `ok` or `blocked` — a stuck op is the ordinary attention state, not an import that never ends: the pile's rows, folders and ops go, and a pile note saved after the bind (a save another tab had pending) is carried into the source as a note of its own first.
  **Held:** the app behind a dialog is `inert` until then (`ImportDialog`, `routes/index.tsx`).
  For the first source that is because the notes being moved are the ones on screen.
  *Revised 2026-10-02:* a later source is held the same way.
  It used to say how it was going in the storage panel and hold nothing, which put the new source in front before any of its notes had arrived, empty and offering to make a notebook in it while the import ran.
  Every new import's row now says `lock: true`; a row an earlier build wrote with `false` is held too (`useHeldImport` no longer reads it), and a cancel still asks whether that one was written in (`writtenSince`).
  Cancel puts back the source that was in front, which for a later source is the account the user already had.
  **Progress** is the engine's `onProgress` (§7), republished by the scheduler at most every 150 ms: an indeterminate bar while the scan lists, a determinate one once it has the count, and the file it is on written faintly beneath, cut in the middle so the file's name survives a long path.
  The "Storage connected" toast is the dialog's to say for a first source: it waits while the credential brought back is still being taken up, since only the bind says whether the app will be held, and is dropped for good once it is.
  **Cancel** (`cancelImport`) halts the scheduler for that source — aborting its fetches — asks the server to disconnect, and then throws the source's rows, row and credential away and puts `returnTo` back in front (`abandonImport`), so the device is as it was before Connect was pressed.
  It refuses to throw away what the user wrote: a later source written in since its bind (`writtenSince`) is kept and the user sent to Disconnect, and one that finished while the cancel was being asked is left alone.
  A server that cannot be reached offers "Cancel here anyway" (the connection lives on at the server, as with "stop syncing on this device") and "Keep importing".
  Files already uploaded stay in the provider; connecting again adopts identical files rather than duplicating them.
- **The credential is written down before the binding**, matching `claimConnection`: a binding the device holds no credential for is one `reconcileAccount` gives up on.
- **The panel lists the sources, and the devices holding the one in front.**
  The device list is the compensating control for the XSS trade below, so it is asked for on open rather than hidden behind a disclosure.
  Both lists are shown only when there is more than one of the thing, since a list of one is noise beside a panel that already names it.
  *Revised 2026-10-02:* the devices are now the *other* devices — this one cannot be removed from itself, and "this device" told the user nothing they did not know — and their rows fold behind a line that says how many there are ("2 other devices signed in on this account"), which is still asked for on open and still said without opening anything.
  The count is what the control was for: a theft shows as one more device than the user has.
  Open, each row names its device by its browser at sign-in (`grants.device`, below).
  *Revised 2026-10-05:* in a wide window's sidebar, where the panel is now one line and a gear (§8, "The storage panel gave connection management up entirely"), the count is a device icon and a number in that line, beside the gear, and the rows open over everything from it.
  It is not in the gear's menu with the rest: there it would be said only to a user who went looking, and being said unasked is the property this control is for.
  *Revised 2026-10-06:* a compact window's source dropdown ends in the same line (§8), so the count is there too, at the line's end, and opens the same rows over everything; the fold-out list it had there is gone.
- **A disconnect names the source it is for.**
  `detachConnection` is given the connection and has no default, because the answer that lets a source go can arrive after the user has switched to another (`reconcileAccount` settles the connection it *asked about*).
  Letting go of "the active one" there would take a source the user never touched and leave the one the server dropped live on the device.
- **`verifyResume` cuts its rows loose in place.**
  It used to send them through `LOCAL_CONNECTION_ID` and back, which was equivalent while the local pile could only be this connection's.
  It is not now: the return trip moved *everything* under `LOCAL`, so a source let go while another was being verified had its notes swept into that other account's storage — dirty, queued, and with nobody asked.
  The scheduler calls `verifyResume` itself, so this needed no user mistake at all.
- **Every `await` inside a store transaction must be on a Dexie operation.**
  `unbindConnection` (since replaced by `detachConnection`) briefly awaited a helper that could answer without touching the database, and Dexie committed the transaction underneath it (`PrematureCommitError`) whenever that path was taken.
  Reads go at the top and the decision is a pure function.
- **Deliberately not done:** `sync.bindings`, the generation counter behind every `ifUnchangedSince` precondition, stays device-wide.
  It answers "did this device's binding state change under me", which is a device-wide question; per-connection counters would miss exactly the interleavings the preconditions exist for.
- **Letting a source go removes what the remote has and keeps what it does not, under the source's own name (2026-09-19).**
  It used to move every row under `LOCAL_CONNECTION_ID`, where they were invisible for as long as any other source was connected — a pile the user could not see, of notes they had been told stay on the device.
  The remote is the source of truth, so `detachConnection` deletes the rows it has been sent, their ops and the credential, and touches nothing remote.
  What `unsyncedIn` says it has *not* been sent — unsent notes, queued renames, tombstones it is owed, unmade notebooks, queued `rmdir`s, and everything while `resumeUnverified` — stays exactly where it is, with the notebooks above it, and so does any note an editor still holds text for that the store would not take (`settleEditors` answers with their refs, and every path settles the editors *immediately* before detaching: a disconnect waits on the server, the confirm is not a modal, and "the remote has the note" is not "the remote has the edit").
  The `syncState` row stays with them marked `detached` (`at`, and `disconnected` for the user's own Disconnect or "stop syncing", `revoked` for the server ending it, `interrupted` for a row made again), stripped of cursor, root and access token.
  With nothing unsent the row goes too — and this tab remembers whose it was (`store/goneSources.ts`), so that a save arriving for one of its notes afterwards makes the row again with its account (`ensureDetached`), where the panel can name it and the same account coming back takes the note home.
  A source made again never takes the screen: what was showing is chosen by name first, the device's own pile included, which the list then offers beside it.
  Every path is this one — Disconnect, "stop syncing on this device", and the server no longer answering for the credential — so nothing is discarded unasked and nothing is moved to another account unasked, whoever was or was not there to ask.
  A detached source syncs nothing (no scheduler session, the sync store refuses it as it refuses a missing row, the token source is never asked) but is shown, editable, and says so: a banner over its notes, `{source} — disconnected` in the list, and a panel offering Reconnect, Download (`store/exportNotes.ts`) and a two-step Discard that lists the notes by title, focuses Cancel, closes on Escape, says plainly that a delete still owed will be carried out on reconnecting, and can reach only what it listed *as it listed it* (`releaseConnection`'s `seen`, each note with its `updatedAt`, the notebooks and directory removals by path: a note written after the list was shown, or written *into* since, is kept, and the source with it; and a source another tab has connected again meanwhile is refused untouched).
  `activeConnectionId` falls back to the first *live* source before a detached one, so a source kept for one unsent note never wins the screen from one that works, but a detached source the user chose stays in front.
  Reconnecting is an ordinary bind: the same connection id clears `detached` in place and queues what is owed; the same account under a new id takes the rows home with `moveRowsTo(…, 'resume', detachedId)` and deletes the detached row; both are `resumeUnverified` if any row is linked to a file.
  Where that connection is already live and has pulled the file a kept row still names, the pulled row stands: a kept edit becomes a conflict copy beside it (fresh id, no file, owed a write) and a kept rename or tombstone is dropped, with an open editor pointed at whichever row stands for it.
  A different account absorbs nothing.
  **And the user is asked first, not told after (2026-09-19).**
  Pressing Disconnect settles the editors, sends one last push where that has any prospect of working (online, and the scheduler neither stopped nor idle-with-nothing-to-sync; ten seconds, after which the question is asked anyway and whatever the push lands is one thing less on it), reads what is unsent, and then *asks* — with nothing said to the server until it is answered, so a cancel has changed nothing anywhere.
  With nothing unsent it is the plain confirm.
  With something unsent it names how much, lists the notes by title (five, the rest behind a `<details>`) with a count per category, says why they cannot be sent where something is in the way, and offers: move them to another connected source, download them, discard them by name, or cancel — Cancel focused, Escape closing, and a failing save in *this* source disabling move and discard, since the rows are then not the whole of what the user wrote.
  The answer runs the server disconnect and then the release in one act (`letGoOfSource`); a server that refuses leaves everything as it was and "stop syncing on this device" asks the same question again with no server behind it.
  **Move** (`moveUnsyncedTo`, `moveRowsTo`'s `only`) takes the notes the remote never had in full and the notebooks around them into the named source, as new writing: no `remoteId`, `remoteVersion` or `syncedHash`, dirty, `source` pinned first so the bytes do not change under the engine, `createdAt`, `bodyOrigin` and `editorMode` kept, its own id unless the target holds that id, the target's spelling of the notebook and a free name compared folded, a fresh `write` apiece and a `mkdir` for each notebook the target lacks.
  Every op of the old source is dropped, and so are its tombstones and the `delete`s and `rmdir`s they stood for — a delete cannot be carried into an account that has no such file, and a dropped tombstone is recorded in `movedRows` so an undo lands in the target.
  Unsent **renames** are not moved either: the file is safe on the old remote under its old name.
  Two things follow and are said in a second step before anything moves — a note pushed once and edited since ends up in both accounts, the older version staying where it was, and the unsent deletes and renames are named with "{A} keeps those files as they are".
  It runs in one transaction with the release and takes the same `seen` care a discard does: what was written since the list was made is neither moved nor let go, and the source stays detached around it — and so is a note an editor still holds text for that the store would not take.
  That last one is `holding`, and the editors are settled *immediately before the release* on every path, `releaseConnection` included: the detach kept exactly those rows so unsavable text would have somewhere to land, and a release that took no `holding` deleted them again a moment later; and a save that only begins failing while the question is being read walks straight past the dialog's own guard, which was computed before it was asked.
  Move refuses outright, touching nothing, in three cases: a target that is not a live source; a source still `resumeUnverified`, where everything it holds is listed as unsent and a bulk copy into another account made on a count known to be wrong is exactly what the silo rule is there to prevent; and a list with nothing of the kind it carries, since “move 0 notes” is a discard of the renames and deletes reached through a button that says Move.
  The undo of a dropped tombstone follows `movedRows` with **both** halves of the forward, id included, and a note brought back into an account that already holds that id is given a fresh one (`freeKeyFor` in `store/notes.ts`, the rule `moveRowsTo`'s `landing` already used): one folder copied into two accounts is enough for two notes to share an id, and a `put` over the other account's row would delete text that, unpushed, exists nowhere else.
  The detached panel offers the same Move, with the same two steps.

**The security trade, stated rather than buried.**
CSRF disappears as a class (a bearer is never sent ambiently) and the blast radius of a theft drops from *every* connection to one.
But `httpOnly` was real protection against exfiltration and IndexedDB is not: an XSS today can mint tokens only while the page lives; tomorrow it can post the credential anywhere and use it until someone revokes the device.
What holds the line is `script-src 'self'` with nothing inline (`apps/web/public/_headers`, pinned by `tests/csp.test.ts`), which stops being a good policy and becomes a hard requirement, plus HSTS on the shell, a device list that makes theft visible and revocable, and lazy idle expiry (180 days).
The `sk1_` prefix reserves a non-extractable-ECDSA proof-of-possession variant that buys the property back; this ships the bearer and keeps the seam.
It is written into CLAUDE.md in words, because a hard-rules list implying IndexedDB is safe for a long-lived bearer is exactly the kind of rule that quietly stops being honest.

**Deliberately not done:** no server-side revocation list, no per-device names, and no proof of possession.
*Partly revised 2026-10-02:* each grant now keeps a label for its device, "Safari on iPhone", worked out from the User-Agent of the app's own request to start connecting (`apps/api/src/device.ts`), carried to the callback in the signed flow cookie, and refreshed when the device reconnects.
*Revised the same day:* it was first taken from the callback, the browser's navigation back from the provider, and a Chrome on a Mac arrived there saying it was Safari on an iPhone; whatever rewrites a User-Agent for the provider's pages (an extension, a site setting) reaches the callback, and the start is the app asking.
It needs nothing that says who is asking — it is what the device is, not whose — and it is the label only: never the header, which says which build of which system, and no address or place.
A row that said only "a device, last used 9:48 AM" could not be told from the phone in the user's pocket, which is the one comparison the list exists for.
Names the user gives a device are still not done.
A grant from before `0006`, or from a browser the label does not know, has none and says "A device".
The device list plus `DELETE` is enough to act on a theft the user knows about; anything more would need something that can say *who* is asking, and after 2026-09-18 there is deliberately no such thing: the credential names a connection, not a person.
A revocation list is the one of the three that could still be built on what exists.

### Data model (Drizzle, D1)
```
users               id, email, email_verified, created_at              (no caller; to be dropped — #118)
identities          id, user_id, provider ('google'|'microsoft'), subject, email, created_at   (no caller; to be dropped)
storage_connections id, provider, account_id, display_name, root_id,
                    secret_ciphertext, secret_iv, secret_key_id, created_at, last_used_at
                    -- unique on (provider, account_id); no user
                    -- secret = { refresh_token } for OAuth, { url, username, password } for WebDAV
grants              id, connection_id (null once revoked), secret_hash, created_at, last_used_at, device
                    -- secret_hash = base64url SHA-256 of the device's `sk1_…` credential, unique
```
Secrets encrypted with AES-256-GCM using `SECRETS_KEY` from env (rotate by re-encrypting; key id stored alongside ciphertext).
Never log secrets.
Never return them to the client.
The credential behind `secret_hash` is never stored at all.

### Endpoints
| Route | Purpose |
|---|---|
| `POST /api/auth/connect/:provider/start` | `{ credentialHash, returnTo? }` → `{ authorizeUrl }`. Storage scopes; PKCE + state + the hash in the flow cookie. Same-origin only |
| `POST /api/connect-code` | `{ code }` → `{ accepted: true, expiresIn }` or `{ accepted: false, reason? }`, from the policy's `checkCode`. 404 where the gate asks for no code. Same-origin only, rate-limited |
| `GET  /api/auth/connect/:provider/callback` | Exchange code, upsert connection with encrypted refresh token **and** its grant in one batch, redirect to app. Asked again within five minutes, the same redirect; with no flow, `/?connect=expired`; any other failure, `?connect=failed`, never JSON |
| `POST /api/connections/webdav` | *(deferred, §5.4)* Validate by `PROPFIND` against the URL, store encrypted creds |
| `GET  /api/connection` | The one connection this credential reaches (no secrets), and this device's `grantId` |
| `GET  /api/connection/grants` | The devices holding this connection, which one is asking, which have gone idle, and what each is (`device`, where known). No hashes |
| `DELETE /api/connection/grants/:id` | Revoke one device, this one included ("sign out"). The grant's row stays, nulled. The connection survives while any other live device reaches it; with the last one it goes as `DELETE /api/connection` takes it, and the answer says so (`disconnected`, `revoked`) |
| `DELETE /api/connection` | Revoke at provider where supported, delete row; every grant is nulled, not deleted. Every device at once; the web app's Disconnect signs out one (`/connection/grants/:id`) since 2026-10-02 |
| `POST /api/token` | No body → `{ accessToken, expiresAt }` using stored refresh token |
| `POST /api/connection/relay/ticket` | No body → `{ ticket, expiresIn }`, for opening the relay socket below. 404 `relay_disabled` where the deployment runs no relay. Rate-limited |
| `GET  /api/relay?ticket=…` | WebSocket upgrade to the change relay ("Change relay", below). Same-origin; the ticket's grant must still be live. Outside `/api/connection*` because a browser cannot send `Authorization` on a WebSocket |
| `ALL  /api/webdav/:connectionId/*` | *(deferred)* Authenticated proxy (see 5.4) |

Everything under `/api/connection*` and `POST /api/token` requires `Authorization: Bearer sk1_…`.
Two refusals, and the difference is actionable: `credential_required` (401) means the device never had one and should connect; `credential_revoked` (401) means the one it holds is not known here any more and should be thrown away first.

There are no sign-in routes, here or anywhere: identity is the storage connection (§6).
`AUTH_MODE=account-first` refuses to boot, which is now a refusal to honour a setting that describes something this project has decided not to build rather than something it has not built yet — the env var itself goes with the tables (issue #118).

### Change relay (optional, 2026-10-05)

Where the operator turns it on, a device that has pushed tells the API and the API tells the connection's other devices, which then pull; it carries that something changed, and nothing else.
The decision record is [`decisions/0003-change-relay.md`](decisions/0003-change-relay.md).

---

## 7. Local store and sync engine (client)

### IndexedDB schema (Dexie)
```
notes        [connectionId + id (uuid)], path, title, body, frontmatter,
             remoteId?, remoteVersion?, contentHash,
             dirty (bool), deletedLocally (bool), updatedAt
folders      connectionId, path, remoteId?
syncState    connectionId, cursor, lastSyncAt, rootId,
             displayName? (what the server last called the account; a label, never an identity),
             detached? { at, reason: 'disconnected' | 'revoked' | 'interrupted' } (no longer synced
               from this device, kept only for what its remote was never sent; not indexed, so no
               version bump),
             boundAt? (when last bound; a tab's per-binding memory of the source compares to it)
             unreadable? ([{ remoteId, path, movedAside? }]: files that are not UTF-8 text,
                          left alone and listed in the storage panel, with where any note of
                          the user's went that one took the name of; written with the cursor,
                          a notice only)
opQueue      seq, connectionId, op ('write'|'move'|'delete'|'mkdir'|'rmdir'
                                   |'upload'|'move-file'|'delete-file'), noteId/fileId/path,
             targetPath?, remoteId? (the folder's, for 'rmdir'; the file's, for 'delete-file'),
             copyOf? (an 'upload' whose bytes are read from another file), attempts, lastError
files        [connectionId + id], path, remoteId?, remoteVersion?, size
fileBytes    [connectionId + id], bytes (ArrayBuffer), version?, pinned (0|1), lastUsedAt
clips        [connectionId + name], state ('pending'|'sent'|'removing'), remoteId?, version?,
             size, preview? (a text's first 500 characters)
clipBytes    [connectionId + name], bytes (ArrayBuffer)
clipThumbs   [connectionId + name], thumb? { bytes (ArrayBuffer), type } (absent: drawn as it is)
pictures     [connectionId + fileId], remoteId?, version? (the original's, as read),
             info (what its header says, or null), copies { [variant]: type, width, height,
             size, lastUsedAt }
pictureBytes [connectionId + fileId + variant], [connectionId + fileId], bytes (ArrayBuffer)
keyFiles     connectionId, state ('none'|'ok'|'newer'|'invalid'), recipient?, remoteId?, version?
             (the last read of `.encryption.json`, §7; gone with the binding)
secretKeys   connectionId, recipient, unlock ('pattern'|'pin'|'password'), salt, rounds, iv,
             sealed (ArrayBuffers: the identities under AES-GCM), tries, triedAt?
             (§7; gone when the source's notes leave the device, and carried home with them)
```

`syncState` also carries `clipboard?: true`, whether this device shows that source's clipboard (§7, "The clipboard"); not indexed.

**A schema version only adds (2026-10-10).**
A new version may add a table, an index or an unindexed field, and move rows in its `upgrade`.
It never drops or changes a table or an index that an older build declares.
A tab running an older build can open against the newer database without hearing of the upgrade: one that was not open for it, or one that was frozen ("A frozen tab lets go of the database" below).
Dexie opens such a tab, and where something the tab's build declares is missing, puts it back with a version bump of its own, before the check on every open can stop the tab.
A version that only adds gives it nothing to put back.
Versions 4 and 5 broke this rule once, to change `notes`' key, which IndexedDB can only do by dropping the store.
A change that cannot be made by adding says, in its own entry here, what a tab a version behind does to it.

**Pictures, as this device has read them (2026-10-08, #276).**
`pictures` holds what a picture's header says (`imageInfo` in `packages/core/src/files/pictures.ts`) and the smaller copies made of it on this device (`pictureVariant`, made by `apps/web/src/pictures/shrink.worker.ts`), with each copy's bytes apart in `pictureBytes` so that writing back a use never rewrites them (`store/pictures.ts`).
None of it is anybody's work.
It is never sent, exported, counted as unsent, or put in the user's folder, and anything missing is made again from the original.
So it has tables of its own, as the clipboard does, rather than rows in `files`.
- **Stamped.**
  A record carries the remote id and version of the original it was read from, both absent while the original is only here.
  It counts only while the file's row is bound to the same pair (`pictureIsCurrent`).
  Where the bytes are known not to have changed, it is re-stamped with the row in the same transaction: on upload and adoption (`releaseBytes`), where the bytes that went up are the ones held here; on a move this device made that kept the file's id (`settleFileMove`); and on cutting a source's files loose from their remote.
  A copy of a file made without its bytes is uploaded from its original, read again then, which may have changed since the picture was read, so its record is not re-stamped.
  A move that landed on another file drops the record.
  Anything else that rebinds the row, such as another device's edit, leaves it stale, to be made again.
  `keepPicture` is given the row as it was read before the bytes were, so a row rebound while they were read refuses what was made of them.
- **Deleted with the file.**
  Wherever a file's row goes — a pull, a notebook deleted, a file no note links any more, a detach's clean-up, rows moved to another source — what was read of it goes too, in the same transaction.
  A source let go of takes all of its pictures with it (`forgetRows`).
- **Refused.**
  A picture the browser could not make a copy of is marked so (`refused`).
  It is shown as it is, and not asked of the browser again while the record stands for these bytes.
  A copy missed is not marked: if a worker failed or was too slow, the copy is asked for again the next time the picture is shown.

**Files beside notes, in the store (2026-10-03, #187).**
A file that is not a note is a row of its own (`SyncFile` in `packages/core/src/sync/store.ts`), mirrored as what the remote says of it — path, id, version, size — and never its bytes, which are fetched when the file is shown and kept apart in `fileBytes`.
Two kinds of row, two rules:
- A **bound** row (it has a `remoteId`) is a copy of the remote's word.
  A pull may rewrite or drop one freely: the worst a wrong one costs is a picture that does not show until the next scan.
- A **pending** row (no `remoteId`) was added on this device and is not uploaded yet.
  It is user data, as a dirty note is.
  A pull never removes one: a `delete-file` for one is refused, and so is an `upsert-file` that does not say it is adopting it.
  A folder's deletion leaves it, and its bytes are `pinned` until they are up.

The store's other promises, each pinned by the contract suite:
- **Bytes.**
  Bytes cached under one version are not the file's under another.
  So `fileBytes` hands back pinned bytes, or cached bytes whose `version` is the row's `remoteVersion`, and nothing else.
  OneDrive moves an `eTag` on a rename, and a move this device made carries its bytes over to the new version, since it knows the bytes did not change.
- **The user's move.**
  A row with a `move-file` queued keeps its path through an `upsert-file`; the move starts from where the remote says the file is.
  Put back where it was, the row would free the name the user chose, and the next file to arrive there would be taken for new.
- **The user's deletion.**
  An `upsert-file` is passed over while a `delete-file` for that `remoteId` is queued, because the queued op is the user's word that the file should go.
  Passed over rather than refused: a refusal rejects the batch, and a delete stuck at the network would stop every pull.
- **Adoption** binds only a pending row at the path, of the remote's size.
  Anything else would let the user's bytes go unsent as a cached copy of another file.
- **A copy's source.**
  A row a pull takes or unbinds hands its current bytes to every queued `upload` that copies its file (`copyOf`), since the remote has just said there is nothing left to copy from.
  A row that goes takes its queued `upload` and `move-file` with it.
- **Folders.**
  A folder move takes every file row beneath it, and their queued ops.
  A folder delete takes the bound rows beneath it and their bytes.
  It spares:
  - every pending row;
  - the files the engine names in `keepFiles`;
  - any file whose own queued `move-file` says it is outside the folder, the same backstop the notes' `keep` has.
- **An `upload` that lands** is bound to what it made, and its bytes are kept as that version's.
  If the user moved the row meanwhile, a `move-file` is queued after it.
  If the user deleted the row, a `delete-file` is queued for what was made.
  If another row already holds the same `remoteId`, the outcome is refused, as it is for a `move-file`: two rows on one file is an engine that lost track, and letting either row go would break a link.
  The op fails and is tried again, and an engine must not adopt a file another row holds.

Bytes are an `ArrayBuffer` rather than a `Blob`.
Every browser keeps a large value of either kind out of line, but a `Blob` does not survive the structured clone of the IndexedDB the tests run on.

**Pushing files (2026-10-03, #187).**
Three ops, each in `packages/core/src/sync/push/files.ts`:
- **`upload`** sends a pending row's bytes to where the row is now.
  The bytes are those held here; for a copy made when a note moved and its file could not go with it, they are the bytes of the file it copies (`copyOf`), read from the remote.
  The provider is told a content type by extension (`contentTypeOf`), which it records and nothing here reads.
  A missing parent is made, a level at a time, as for a write.
  Something already at the name is handled in one of two ways:
  - **The same file** — a file the size of the bytes being sent, that no other row holds and no queued `delete-file` is to take — is adopted.
    It is this device's own upload whose answer never came back, or the same picture added on another device; names carry the bytes' hash, so a name and a size that both match are almost always that.
  - **Anything else** keeps the path, and the upload goes beside it as `<stem> (conflict <stamp>).<ext>`.
    The note that links the file is not rewritten.
    The conflict name is chosen from one listing of the folder and the rows here, not found by trying names: Dropbox and OneDrive take the whole body before they say a name is taken, and a row not yet sent holds its name as surely as a file there.
    A second clash is a race with another device; eight, and the op fails and is tried again.

  With no bytes here and nothing left at `copyOf`, the row goes (`lost-file`).
  Only a not-found says that: any other failure to read the original fails the op, and the copy is tried again.
- **`move-file`** moves by id, from where the op says the file is (the store keeps that current as pulls move it) to the row's path.
  A not-found is asked of the origin folder's listing, never of the file, since reading the file would download it: gone, the op is done; still there, the target folder is made and the move tried again.
  The same file at the target is adopted, and the one moved from is left where it was, because another note may link it there.
  That includes a note on another device, which copied the file rather than moving it.
  Until a full scan this device does not see that file again: a known gap, and nothing is lost.
  The row keeps no bytes it had cached, which were the other file's.
  Anything else at the target and the file goes beside it, as an upload does.
- **`delete-file`** deletes by the id the queue recorded.
  Not found is what was wanted.

`rmdir`'s third gate counts file rows, so a notebook holding a file not yet sent is the user's still.

**Uploads do not hold up the queue.**
This is the second exception to the ordered queue, after `rmdir`.
An upload that fails is counted against its attempts and stepped over, and one out of attempts is stepped over and kept.
It is never completed: it is the only copy of the file.
A note that links the file goes without it, and other devices show the file as not there until it lands, which heals itself.
- **Order.**
  An upload's first try keeps its place, so a file lands ahead of the note that links it, and the edits behind it wait for that one try.
  Once it has failed, each push sends it after everything else, so the edits queued since do not wait out its further tries on the connection that failed it.
  A copy (`copyOf`) keeps its place, for the reason in the last bullet.
- **Status.**
  The outcome carries `waitingUploads`.
  Its status is `retry` when an upload failed this run, and `blocked` when one is out of attempts; the scheduler gives a blocked queue its attempts back in time, as for any stuck op.
  A conflict resolved, or a failure met, behind a stepped-over upload keeps that count.
- **What it costs.**
  A `retry` arms the scheduler's backoff for the whole connection, so an edit made after an upload failed waits for the backoff (5 s, doubling to 5 min), as it would after any failed run.
  Kept so on purpose for a run that failed only on uploads (2026-10-03, #187): an upload that fails is a provider or a connection failing a request, which the next note's write would most likely meet too, and a backoff that spared upload-only runs would send the 25 MB again on every trigger while the connection is down.
  The edits queued behind it are not lost, only later, and the user's Sync now skips the wait.
  The queue is read once, when a run begins, so an edit typed while an upload is on its way waits for that run to end as well — up to the nearly ten minutes a 25 MB upload is given at 50 KB/s (§4) — and goes in the next.
- **Naming what is stuck.**
  `stuckOp` in `apps/web/src/sync/scheduler.ts` names the first op out of attempts that is *not* an upload, which is the one that stopped the drain, and an upload only when nothing else is given up on: the queue is ordered, but an upload stepped over holds nothing up.
- A rate limit or a refused token still stops the drain, since neither is the upload's fault.
- **What waits.**
  One op behind a stepped-over upload does wait for it: a `delete-file` of the file the upload copies.
  Sent first, it would leave the copy nothing to read, since a deleted file cannot be read back by its id — trashed on Drive, gone on OneDrive and Dropbox.
  What that held delete is still in the way of waits with it: an `rmdir` over it, which would find the file and leave the folder standing for good; and an upload or a `move-file` to its name, which would meet the file on its way out and go beside it, away from the name the note links.
  An upload held so counts as waiting, and a copy among them holds back the delete of what it copies.

**Pulling files (2026-10-03, #187).**
Every listed file that is not a note and not hidden becomes a row, or brings its row up to date.
Nothing is downloaded: bytes are fetched when the file is shown.
No file decision calls the network, because a wrong bound row costs at most a picture that does not show until the next scan.
The rules, in `packages/core/src/sync/engine.ts` (`decideAttachment` and the functions around it):
- **Matching.**
  An entry is matched to a row by `remoteId` first.
  A row whose remote path, version and size are unchanged is passed over.
  Failing that, a pending row at the entry's path with the entry's size is adopted: an upload whose answer never came back, or the same picture added on two devices.
  Otherwise the entry is a new row.
- **The remote keeps the path.**
  A row in the way that has no file at that path, either never sent or moved there by the user, steps aside to a conflict name that keeps its extension (`displace-file`), and its upload or move goes there instead.
  A bound row in the way is let go of, unless the batch says later where its file went.
- **The user's word.**
  An entry for a file with a `delete-file` queued is passed over.
  A row with a `move-file` queued stays where the user put it, and the move's origin follows the remote.
- **Deletions** are matched by id, or, on Dropbox, by path against where the file is on the remote.
  A bound row goes.
  A row the user moved here is theirs, as an edit is: it is pending again where the user put it, and sent from the bytes held here (`reupload-file`).
  Where none are held it is pending all the same, and goes when its upload finds nothing to send (`lost-file`).
  The engine cannot see the bytes without reading up to 25 MB, and a row the store dropped while the engine still placed it got a later change in the batch refused, and with it the batch, on every pull for good (#194).
  The same holds when the folder its file was in is deleted there, which the cascade alone would not reach, because the row is no longer under it; and when another file is listed at the row's old path with no word of where its own went, as Dropbox reports a file replaced in place, where the move would find nothing to move (`originsTaken`).
- **Folders.**
  A remote folder's deletion takes the bound rows under it, and keeps pending rows and the rows the user moved into it, whose files are still elsewhere there.
  The notebooks they need are made again, as they are for a note a cascade keeps.
  It also spares (`keepFiles`) a file the rest of the round lists again, so that its own entry puts it where it now is as the same row, with its bytes; taken by the cascade, it would come back as a new row with none.
  This is the files' answer to the subfolders a deletion rescues.
  A folder's move carries its rows.
- **Across kinds.**
  A note's file renamed to a name that is not a note's lets the note go, as a deletion would.
  A file renamed into `.md` loses its row and is imported as a note.
- **Hidden paths.**
  An entry at a hidden path is passed over, so it says nothing of where a file went.
  A file moved into `.trash` is gone, as a deletion would say, and no rule reads the trash as its next place (`Batch.listed`, #194).
- **Scans.**
  A bound row that a full scan did not return goes, as a deletion would take it, so one the user moved is sent again.
  On an upload-differences reset every such row is sent again, and one with no bytes held is pending until the push that follows lets it go.
- **A known gap.**
  A row the user moved into a notebook, with the notebook and the file both deleted there and no bytes held, has the notebook made again for it, as for a note a cascade keeps.
  When the row goes at the push, the notebook stays, empty and local.
  Rare: the app moves a file only with the note that links it, or with its notebook.
- **A backstop**, `settleFileClashes`, settles two rows left at one path at the end of a batch.

Within a batch, the decisions are replayed over the file rows exactly as the store will apply them (`placedFiles`), memoised per batch.
Exactly, because a row the replay and the store disagree about has a later change about it refused, and the batch with it, on every pull.
The single-device soak (`randomRemote.test.ts`) checks after every pull, on every stub and page size, that the rows are the remote's files that are not notes.
The two-device suite (`overProviders.test.ts`) does the same at rest, and checks that a file added on either device reaches the remote with its bytes unless its notebook was deleted.

**Files in the library (2026-10-03, #187).**
The app's own writers, in `apps/web/src/store/files.ts`, `queue.ts`, `notes.ts` and `folders.ts`:
- **Adding a file** (`addAttachment`) refuses anything over 25 MB, and a `.md`, which the engine would take for a note.
  The bytes are hashed outside the transaction.
  The name is `<slug stem>-<8 hex>.<ext>` in the note's folder (§3).
  A file already at that name, compared folded, with the same size is the same file, and nothing is made, though the note's write still goes behind its upload where it is not up yet; one of another size makes the name take 16 hex instead, so no body is ever rewritten.
  Otherwise one transaction writes the pending row and its pinned bytes, queues the `upload`, and sends the note's queued write, if it has one, to the back behind it (`requeueWriteBehind`): `queueWrite` adds nothing while a write is queued, so a write queued earlier would otherwise send the note ahead of the file it links.
  It answers the markdown, which the editor inserts as the user's own edit.
- **The queue.**
  `queueMoveFile` is `queueMove`'s rule for a file: it replaces an earlier move, keeping its origin, and withdraws one that would end where it began.
  For a pending row only the upload's `path` follows the row.
  `queueDeleteFile` withdraws the file's upload and moves, and for a bound row queues a `delete-file` by id, from where the remote has the file, with no `fileId`, since the row goes.
- **A note's move** carries the files it links in its own folder (`carryLinkedFiles`), inside the note's transaction and ahead of its ops, so that its pictures show at the new place at once, offline too.
  A file another note in the old folder links — live or deleted, since a delete can be undone — is **copied**: a new pending row with the bytes, if this device holds the file's, and `copyOf` if not.
  Any other is **moved**.
  A file the destination already has by that name and size is left alone, as the same file, by the rule an upload adopts one by; the note's write goes behind its upload if it is not up yet.
  One there of that name and another size, which a name the app did not choose makes likely enough (`image.png`), keeps the name, and ours is carried beside it under a conflict name that keeps its extension, as an upload goes beside one (#195).
  The note then shows the file there, since its body is never rewritten, and its own is not left in the old folder, linked by nothing, for that notebook's delete to take.
  A file elsewhere that the note links by `../` stays where it is: whether a note in another notebook links it too is not looked for, since that would parse every note in the source on every move.
  A rename within the folder carries nothing.
- **A notebook's move** re-paths every file row under it, and queues a `move-file` for each bound one, ahead of the notes' moves, so no note arrives before the files it links, and ahead of the `rmdir`s, which a file left in the old directory would keep standing.
  A destination is refused (`FolderExistsError`) when a file is in the way, as it is for a notebook: a file keeps its name, because the notes that link it say it, so it cannot give way as a note does.
- **A notebook's delete** deletes every file in it, and the confirmation counts the files (`FolderNode.fileCount`, counted, never drawn as a notebook).
  Rows and bytes go at once, since nothing brings a file back, and the `delete-file`s are queued ahead of the `rmdir`s.
  A file whose upload is on its way when its notebook is moved or deleted owes its `move-file` or `delete-file` only once the upload lands, behind the `rmdir`s queued meanwhile; so the store sends those `rmdir`s to the back then (`uploaded`, #195), and run first, they would have found the file and left the directory standing for good.
  First, a copy elsewhere that was to read one of them from the remote is handed the bytes, where they are held (`handOverToCopies`), as a pull's deletion does in the store; where they are not, the engine holds the delete back until the copy has read it ("What waits").
- **A file no note links (2026-10-04).**
  Taking a link out of a note, or deleting the note, leaves the file, and nothing showed it again.
  A notebook's `⋯` offers **Attached files** where it has any (`FolderNode.fileCount`): each file directly in it, with its size, and under its name the notes in the source that link it — a deleted one, not yet sent, saying so (`components/attachments/AttachedFiles.tsx`, `store/fileLinks.ts`).
  One no note links can be deleted there, after a second Delete.
  **A note links a file when its body names it anywhere**, not when a parser finds a link: a link may spell a name escaped, percent-encoded or with a character reference, with `#page=2` after it, in an `<a href>` or a `<video src>`, in another app's wiki link, from another notebook by `../`, or — cut from one note and pasted into a note in another notebook — pointing nowhere and still meaning the file.
  A parser that missed one would have the file deleted under the note that shows it, and the first review found six it missed; a name found where it is no link only keeps a file.
  So every note in the source is read as written and decoded, folded (`foldName`), and a name the app stamped with its hash is kept by a note that has the stamp anywhere.
  A note deleted here and not yet sent counts, as it does for a note's move (`carryLinkedFiles`): its delete can be undone.
  **Nothing is deleted where the device may not hold every note in the source** (`holdsEveryNote`): importing, resumed and unchecked, detached, never pulled to the end, or with a note it cannot read as text — a note it does not hold may link the file — and the dialog says so in place of Delete.
  `deleteUnlinkedFiles` asks all of that again inside its own transaction rather than trusting the list the user was shown, and deletes as a notebook's delete does: a copy elsewhere waiting on the bytes is handed them, the rows and bytes go, a pending file's upload is withdrawn and a bound one owes a `delete-file`, which a provider puts in its trash.
- **A file taken out of a note is deleted a little after the note is left (2026-10-04)**, if no note in the source names it then (`store/fileCleanup.ts`).
  After, not as the link goes: while the note is open an undo can bring the link back, and the editor's history goes with the editor.
  Three minutes after, and for a source with a remote not before a pull has reached the end since the note was left (`lastSyncAt`), so that a link another device has added is here to be found; while it is too soon to tell it is asked again every three minutes, for up to an hour, and a note opened again holds its files until it is left again.
  Only the files the note linked when it was opened and those put in it since (`useFileCleanup`, told of each by the note's attachment host), less any it still names as it is left — as last typed, saved or not, and as a pull has made it since (`bodyOrigin`) — and only after an edit: a file nobody took out of a note is never looked at, and a picture pasted and deleted again is the commonest file nothing links.
  So a note edited and then deleted keeps its files: deleting a note deletes none of them, since the delete can be undone.
  The store asks of every note again before it deletes, by name as above (`deleteUnlinkedFilesAt`), and not at all where the device may not hold every note.
  Held in memory: a tab closed before the time is up deletes nothing, and Attached files still lists what it left; and the tab that deletes knows nothing of another with the note open.
- **Unsent.**
  A pending row is unsent work (`Unsynced.files`), counted by `countOf` and `isEmpty` and held to by `seenIn`, so the disconnect dialog says "2 files not yet uploaded" before it lets a source go.
  A bound row's move or delete goes with the note or notebook that queued it, which is counted already.
  What connecting, detaching, moving and discarding do with files is "Files across sources", below.
- **Scope.**
  Every writer in `store/notes.ts` opens `files` and `fileBytes` (`writerTables`), since a move carries files and a caller may wrap several writers in one transaction; and so does every transaction in `store/connection.ts`, which asks `unsyncedIn` inside.

**Files across sources (2026-10-03, #187).**
A file goes where the notes beside it go, by the rules the notes follow ("Letting a source go", §6), in `apps/web/src/store/connection.ts`:
- **Placed in another connection** (`placeFiles`, from `moveRowsTo`), a file is one of two things.
  Resumed at the path it had — its own account back under a new id — it is the row it was, bound or pending, with its bytes as they were, and what is queued for it follows it.
  Anywhere else — copied from the device's pile, carried to another account, respelled on the way — the target's remote has never heard of it: it is a pending row, its bytes pinned and the version they were cached under dropped, owed an upload.
  Where this device holds no current bytes of it (`heldBytesAreCurrent`) nothing could send it, and it is not placed: the account it came from still has it, which a pending row could never say.
  A row the target already has for the same file stands, as a note's does: the one with its `remoteId`, on a resume, or one at its name, folded, with its size, by the rule an upload adopts one by.
  One at its name of another size keeps the name, and ours goes beside it under a conflict name that keeps its extension; no note is rewritten.
  A file whose id the target holds takes a fresh one, and its ops follow it.
  A file is taken from its source only when the whole source moves.
  Named one by one, files are copied, as notebooks are, since a note staying behind may link the same file.
- **Order.**
  `queueOwed` queues notebook by notebook (2026-10-05), as an import does ("Getting a library in", below): the notes at the top first, then each notebook's `mkdir`, the uploads of its files and the writes of its notes, before the notebooks inside it.
  So another device fills in a notebook at a time, and no note reaches a remote ahead of the files beside it.
  A file is queued one upload however many ways a bind finds it owed (`queueUpload`), as a note is one write.
- **Connecting** copies the pile's files with its notes, and the pile keeps them until the import is through.
  A pile note written in after the bind carries the files it links when the import finishes; a cancelled import forgets the source's files and bytes and leaves the pile's.
  A bound file that comes back with a resume, or with a rebind under the same id, names a remote file nobody has looked at since, so it marks the connection `resumeUnverified`, as a bound note does.
  A pending file that lost its upload is owed one on the rebind (`owedInPlace`); one that kept it is not sent twice.
- **Unverified.**
  While a resume is unchecked, a bound file whose bytes this device holds is listed as unsent as well: nobody has looked for it on the remote, and those bytes may be the only copy.
  Only which files have bytes is read, by key, since `unsyncedIn` runs on every change to a source in the tab bar.
- **Cut loose** (`cutLoose`, a resume whose remote turns out not to be the notes'): a bound file with current bytes becomes pending, pinned, owed an upload; one without goes, since nothing could send it and a scan that finds it brings it back.
  A pending one keeps its upload, which names no remote file, `copyOf` and all: a copy whose bytes are read from the remote is told `lost-file` where the remote does not have them, and goes then.
- **A detach** (`keepOnly`) keeps every pending file, every file a kept note links, bound or not, so that its pictures still show, and every file whose `move-file` is owed, as a note's rename is: a notebook renamed here can hold files no note links, and one left behind would keep the old directory on the remote after its notes had gone.
  Their bytes stay, with their ops, the notebooks they are in, and every `delete-file`.
  The rest go, bytes and all.
  A discard or a move that leaves something written since the list keeps by the same rule, less the files the list stood for.
  A detach that finds nothing unsent forgets the source's every row, a file's owed move or delete included: under a source nothing names they would be rows nothing shows and ops nothing sends, and the files are the remote's, as they stand.
- **A move to another source** (`moveUnsyncedTo`) takes the files the user was shown and every file a moving note links, where this device holds their current bytes, with the notebooks they are in and no others.
  The rest stay in the account being left: a linked file never downloaded, and a copy a note's move owes of one (`carryLinkedFiles`, read from the remote by `copyOf`), which no other account can be sent — `Unsynced.portable` is the pending files that can go.
  The confirmation says so before the user presses Move, from `linked` and `portable`.
  A pending file that can go is something to move on its own (`movable`), and the button counts it: "Move 1 note and 1 file to …"; a copy alone is nothing to move, and a Move is never a discard of one.
- **A detached source never downloads**, so nothing but its own rows can bring its bytes back: the cache's eviction has to spare them.

### Sync loop (per connection)
1. **Pull**: `changes(cursor)` → for each remote entry:
   - new/updated remote, local clean → fetch content, upsert local, update `remoteVersion`.
   - new/updated remote, local dirty → **conflict** → apply rule from §1.
   - remote deleted, local clean → delete local.
   - remote deleted, local dirty → keep local, mark `remoteId = null` (will be re-created on push).
   - Persist cursor only after the batch commits to IndexedDB.
   - Cold start on a new device is a full scan (`changes(undefined)`); no remote index file.
     Revisit only if cold start exceeds ~10 s at ~2k notes.
   - A full scan reports how far it has got (`SyncEngineOptions.onProgress`, 2026-09-23).
     **It lists every page before it reads a note**, where it used to read each page as it was listed: no provider gives a total up front, and listing first is what gives one before the first download rather than after the last.
     Nothing is lost by it — a scan's pages carry no cursor, so an interrupted scan starts from the top either way — and pages are still decided and applied one at a time, so notes still appear as they arrive.
     While listing it says how many notes it has found so far; after, `done` of `found`, counting a note already held at its version as done without reading it (so a resumed import does not claim to download everything again), with the `path` of each file read.
     The push after it reports `done` of `total` ops and the path about to be sent.
     A round from a stored cursor reports too (2026-10-05): it reads every page before it decides any ("A round is one batch", below), so it knows how many notes it names before it reads the first, and says `done` of `total` as each is decided — read, or already held at its version, as this device's own push reported back is.
     It was thought short and reported nothing; but another device's import of a thousand notes is one round, nothing of which shows until all of it is read, and on Google Drive that is two requests a note one after another — minutes in which the other device showed its notebooks and nothing in them, with nothing to say why.
     The round is still applied whole; only the count is new.
     **It says so while it reads its pages, too (2026-10-13).**
     Reported on a phone: after a lot of notebooks were moved on the desktop, "Syncing…" for minutes with nothing else, and then a count.
     A notebook moved is not one folder moved on the remote — `moveFolder` sends a `mkdir` for each new folder and a move for each note and file in it — so the other device's next round names every note moved, and its pages were read with nothing said: on Google Drive each page also lists, one request a folder, every folder new in the round (four at once since a later change the same day, §5.1).
     A round now reports `receiving` with `listing` before its first page, and after each page that names more notes, how many it has named so far (`total`, `done` 0), then `listing: false` with the whole count — even when that is none, so the words never outlive the reading.
     A scan reports before its first page as well.
     The line says "Checking…" (a scan, "Looking for notes…") from the first, and the count with a bar that does not know of how many once it has found twenty; on Drive a round of up to a thousand changes is one page, whose folder listing is still read before there is any count to give, so there it says the words alone.
     The storage panel shows the count (`syncCount` in `components/account/statusWords.ts`, which reads it as a run's details and a first import's dialog do, with `runCount`, `runBar` and `runSentence` in `sync/progress.ts`): in a wide window, in a few words in the status line at the sidebar's foot ("120 of 1,000 sent"), with the sentence and the file it is on in the line's tooltip and a bar in the panel's padding under it; in a compact window, as the panel's sentence over the bar.
     A round or a push of a few notes is not shown as a count: the panel says how many only from twenty up (`PROGRESS_FROM`), so an edit's sync does not flash a bar.
   - **A pull keeps what it has read until its batch commits (2026-10-05).**
     A batch is all or nothing — a round always, and a scan a page at a time, which on Google Drive is a thousand notes (`PAGE_SIZE` in `providers/gdrive/wire.ts`) — so a pull that failed at the last note threw away every note it had read, and the retry read them all again.
     On a phone that is every time the screen goes off mid-import: the network goes with it.
     The engine now keeps each note it reads (`held` in `packages/core/src/sync/engine.ts`), by remote id and the version the read reported, and answers a later read of that file at that same listed version from it; a committed batch's entries are let go of, entry by entry rather than all at once, since a retried scan commits its earlier pages again before it reaches the one that failed, and all of it once a pull reaches the end, when what is left is a file the listing no longer names.
     Only the pull's own read of a note goes through it — never a read that asks whether a file is still there, which is about now, nor the push's.
     It is in memory, so it lasts as long as the engine, which is one session of one connection (`follow` in `sync/scheduler.ts`): a reload, a switch of source, or another tab taking the sync lock starts empty.
     Not capped: the strings are the ones the batch's own changes hold while it runs, one version per file.
     Committing a scan in smaller pieces instead was looked at and set aside: the engine decides each entry with the whole batch in view (`noteForEntry`'s look at `batch.live`, `movesOn`, `claimed`), and a rescan split part-way can give a note's identity to the file that took its name.
     That is already true across a provider's own page boundaries on a rescan, and is its own issue.
   - **Syncing says when it waits on this device (2026-10-10).**
     Reported on a phone: "Google Drive · Syncing…" for minutes and nothing else, while the run sat behind reads another tab of the app had left open (§7, "A frozen tab lets go of the database").
     To the user that looked like a slow network.
     IndexedDB does not say a transaction is being kept waiting, nor on what, so the tab follows its own (`store/heldUp.ts`, a Dexie middleware the app's database gets in `watchTab`, with the tab's other watchers; a database made for a test, or beside the app's, gets none of them, so as not to leave a `freeze` listener on `document` for each one): when each is made, when its first answer comes, and when it ends.
     A transaction runs once no transaction made before it on a table it shares is still going, and its first answer then comes in milliseconds.
     So the oldest of the tab's transactions still going, while it has had no answer, can be waiting only on another connection's, since nothing of the tab's own is ahead of it.
     A younger one may be waiting behind the tab's own work, such as an import or a sync's batch, and is not counted, so that work is never taken for another tab.
     An answer counts only where IndexedDB gave it.
     The middleware sits under Dexie's own (level -10), so that the cache answering a live query from memory is not taken for one, and neither is an empty write or a read of no keys, which Dexie answers without asking.
     Either would have a waiting transaction counted as running and every wait behind it go unseen (found in review).
     Listeners are told in a task of their own, outside every transaction and live query.
     **Every transaction is followed, not only the run's.**
     The first cut handed over the store's calls and the run's first read, and missed the phone's case: a frozen tab's reads hold up no read, only the next write to what they read, and after an empty pull that is the write that ends a first import (`finishImport`), which nothing handed over.
     While a run is under way (`watchWaits` in the scheduler, to the end of what it writes after), a wait that lasts 5 s (`SYNC_WAIT_MS`) with the run getting no further makes the status say `waiting`.
     Progress starts the time again, since a count going up under "Waiting for a tab" would be saying two things at once.
     It is set in `syncing` only, and dropped with the run, as `progress` is.
     Any of the tab's waits counts, because the run is the next to need what is held.
     The status line then says "Waiting for a tab" in place of its count.
     The tooltip, the compact panel and a first import's dialog give the whole sentence, and the bar stays where it had got to.
     The one thing counted that is not waiting is a first request whose own work is long, a read of an entire, very large library on a slow device.
     The "Sync now" press frees blocked ops before the run starts, and a wait there is not said: it happens while the line still shows the last sync time, not "Syncing…".
     **Behind another tab's sync, too (2026-10-13).**
     A run takes its connection's sync lock (`skysa-notes:sync:<id>`, a Web Lock) before it reaches the engine, and the line said "Syncing…" for as long as another tab of the app held it, since a lock is not IndexedDB and `heldUp` does not see it.
     A run that has waited 5 s for the lock now says `waiting` as well (`waitForLock`), until the lock comes, whatever the database says meanwhile.
     A lock this tab's own work holds is not another tab's: a run a pause let go of, still putting its batch away, or a re-scan clearing the cursor.
     The tab knows which locks it holds (`underSyncLock`), and behind one of its own it asks again 5 s later instead.
   - **A sync can be looked into, and paused (2026-10-13, the owner's choices).**
     Asked for on a phone, after minutes of "Syncing…" with nothing to say what it was doing and no way to stop it.
     While a sync is going or paused, the status line's words are a button (inside the line, so the line stays the same element whatever it says; whatever it says since 2026-10-14, below), and it opens what the run is doing in a dialog (`SyncDetails` in `components/account/StatusLine.tsx`): the sentence, the bar and the file it is on, as a first import's dialog has them (`components/ui/RunProgress.tsx`, shared), and **Pause syncing**.
     During a first import its own dialog says all of it.
     Pausing (`pause` in the scheduler) ends the session as a cancel does (`halt`), which aborts every request the run has out, and makes the next one paused: it publishes `paused` and runs nothing, and every trigger — the minute, an edit, focus, the network back, another device's notice — goes through `run`, which refuses while paused; going offline does not say `offline` over it.
     The session is a whole one, so a file beside a note is still read when it is opened; the clipboard is not refreshed.
     A batch the run was already writing is written whole with its cursor, so nothing is half-applied, and an op whose request was aborted is given back the attempt that counted against it once the run lets go.
     It lasts until the user asks again — **Resume syncing** in the dialog, which is Sync now, Sync now on the gear, or a re-scan — or the source is shown again after another, or the app is opened again: in memory only, so a reload never leaves a device unsyncing without its user there to see it.
     The line says "Paused", with the sentence saying edits are kept and sent when it resumes.
     "Pause", not "Stop": "Stop syncing on this device" is something else.
     A disabled menu item is drawn as one (2026-10-13): Sync now and Re-scan were disabled while a sync went and looked as every other item did, so a tap on one seemed to do nothing.
   - **The line names no source, and opens the dialog whatever it says (2026-10-14, the owner's choice).**
     It said "Dropbox · Synced 12:04", and with the source's name in it a narrow sidebar wrapped it onto a second line and back as its words changed: "Synced 12:04" fits, "Receiving 120 of 1,000" does not, and the panel jumped each time.
     The source is the tab selected above it, so the line now says only how syncing is going.
     Its tooltip still begins "Syncing with Dropbox · *account*", and since a phone shows no tooltip, the line is a button whenever the source syncs, but during a first import, opening `SyncDetails`.
     With no session (`local`) it is the source's name, as it was, and nothing to open.
     The dialog's title names the source and the account, "Syncing with Dropbox · ann@example.com", or the source alone until the server has said who the account is.
     Idle, it says when the last sync was, with its ✕ alone.
   - **One line, and the bar in the padding (2026-10-14, the owner's ask).**
     Without the source's name the line still wrapped on a desktop: "Checking for changes…" took two lines beside the count of the other devices and the gear where "Synced 12:04" took one, so the panel grew and shrank as a sync began and ended, and the bar of a long one, in a row of its own under the line, moved it again.
     Measured in a 240px sidebar, the widest, the words have 175px beside the gear and 131px with the count as well; in a window just wider than a compact one, 120px and 76px.
     So the words are shorter, each fitting the 131px at the counts a sync usually has ("Checking…", "40 changes found", "1,234 notes found", "120 of 1,000 sent", "Waiting for a tab"), with a count first, so that a cut leaves the numbers.
     And the line is one line whatever it says, cut with "…" where it does not fit (`.account-status`): the whole of it is in the tooltip and in the dialog the line opens.
     The bar is drawn in the panel's bottom padding, centred in it (`.account-bar`), and takes no room: the panel is one height from the start of a sync to its end.
2. **Push**: drain `opQueue` in order — except that where the provider takes more than one at a time (`StorageProvider.writesAtOnce`, 2026-10-05), the writes of notes at its front go that many at once (`together` in the engine).
   That is four on Google Drive, where a new note is three or four requests end to end and, one at a time, an import of a thousand took most of half an hour; four is well inside its limits (a user has 325,000 quota units a minute, a note costs a few hundred: https://developers.google.com/workspace/drive/api/guides/limits).
   Dropbox stays at one: it locks the namespace for each write, and enough at once are answered `429 too_many_write_operations` (https://docs.dropboxapi.com/dropbox-api/docs/performance), a rate limit that backs the whole sync off.
   OneDrive stays at one until it has been measured.
   Only notes' writes go together, each at its own path, and not the write of a note with a rename queued: that write takes the rename with it, and another note's write can be waiting on the name it gives up — renamed b→c and a→b, both edited, and sent together, the second met b.md still taken and was put beside it as a conflict.
   A notebook made or removed, a move, a delete and a file each go alone in their turn, since those are what later ops depend on.
   A notebook missing under writes sent together — deleted on another device while they had edits — is made once between them: each making it, Drive made one apiece, since its `createFolder` asks first whether the folder is there and none was yet.
   The requests per note on Drive were left as they are: dropping the search before a create would save one in four, but it makes a duplicate on Drive that the search after must trash on every name already taken, which the stub cannot hold and no live run here has checked; and a folder-id cache is still refused (§5.1), the more so now — a notebook another device deletes in the middle of an import is what a device shown it empty does, and a cached id would send the rest of the import into the trash.
   `write` passes `expectedVersion = remoteVersion`; on `ConflictError` → run conflict rule, re-queue.
   On `AuthError` → request token from backend, retry once, else pause connection and surface in UI.
   Exponential backoff per op; give up after N attempts and surface.
3. Triggers: app open, tab regains focus, `online` event, 60s interval while visible, Background Sync API when available (best effort), immediately after a local edit (debounced 2s), and — where the deployment runs the change relay (§6) — a notice that another device of the connection has pushed, and 3 and 10 s after the last such notice.
   The relay is one more trigger, never a replacement for the others: it hears nothing of edits made in the folder by other tools.

### Folder renames/moves
A remote folder rename or move is applied locally unconditionally, including when notes inside it are dirty: the move is metadata-only and does not conflict with content edits.
Dirty notes keep their pending content ops and simply get their `path` rewritten; queued ops that reference old paths are rewritten before push.

A folder renamed, moved or deleted *here* is not one op either: its notes and the files beside them (#187) go up as moves or deletes, and an `rmdir` follows them for **each** directory they left, outermost first.
The bullets below say when an `rmdir` removes anything — which is only when the folder is still the one the queue meant and holds no file at all.

One op per directory and not one for the outermost, though the outermost really does take its subdirectories with it on every provider, so each of the others sends nothing.
The op is not only how the directory is removed: it is also how the *pull* knows the directory is spoken for.
A sync pulls before it pushes, so between the move and the push the old directories are still on the remote, and the rows that named them have been re-pathed and stripped of their ids — which is what stops a full scan reading the id at the old path as a remote rename and undoing the move.
To that pull they are directories nobody owns.
`decideFolder` already refuses to make a notebook of one whose `rmdir` is queued, but it matches the op by id **and** path, which is what keeps it from dropping a folder another device has moved since; a subdirectory with no op of its own matched nothing.
So the whole subtree came back — the notebook at its old path, ancestors conjured to hold it — and the outermost `rmdir` was then refused, because the device held a row under it again.
The duplicate was permanent and on the remote as well as in the sidebar.
Found by re-parenting a notebook that had been dragged into place a round earlier (2026-09-22): a directory this device made in the round before is exactly what its own next pull reports, which is why it needed a drag, a sync, and another drag to show up at all.

### Re-arranging is moving

The sidebar's tree is the user's actual directory structure, and the note list is sorted by when each note was made, newest first — not by when it was last edited, which it was until 2026-10-01: an edit moved the row being typed into to the top under the user.
Neither has a position stored anywhere, and there is nowhere on any provider to store one: a directory listing has no order of its own, and the app reads the folder with whatever tool the user also reads it with.
So dragging a notebook or a note **re-parents** it — it answers "where does this live", which is `moveFolder` and `moveNote`, both of which existed for this and until now had no caller in the UI.
Dragging a row to a position among its siblings is deliberately not offered: it would mean an invented order living either on the device (two devices then disagree about a tree they are both looking at) or in a sidecar file in the user's folder (a new format, a new conflict surface, and a file the user did not write).
If hand ordering is wanted later it is that decision that has to be made first, not this code that has to be extended.
Pinning (2026-10-05, below) is not that: it is one mark on a row, kept on the device as which notebooks are open is, and it lifts the row above its siblings without giving any row a position.

`apps/web/src/store/rearrange.ts` holds which drops are allowed, with no DOM in it, because each refusal is a gesture the pointer can really make and each is worth a test: a notebook into itself or into one of its own descendants (`moveFolder` throws, but a drop is not a way to find that out — the row has to say no while the pointer is over it); anything into the folder it is already in; and a note onto the top level, since notes outside a notebook exist only because a remote folder can arrive holding them and the app never *makes* one (§12.6).
That last one is one-way on purpose: a loose note can be dragged into a notebook and not back out.
A destination already holding a notebook of that name is *not* refused there — the tree is not given to that module, and `moveFolder` already answers it with the `FolderExistsError` the route renders for a duplicate name elsewhere, in the same words.

The mode is one piece of state in the route, because the two ends of a note's move are in different panes: the row is in the note list and every destination is in the sidebar.
It is set by `dragstart` **or** by a command, and nothing downstream knows which — that is how the pointer gesture and its alternative stay one implementation.
The alternative is not optional: WCAG 2.2 SC 2.5.7 asks that whatever dragging does be doable with a single pointer that does not drag, so `notebook.move` and `note.move` are registrations like any other (§7, "Commands are declared, not collected"), the destinations are ordinary buttons a click or Enter activates, and Escape — listened for on the document, since a move started from the palette leaves the focus nowhere near the tree — puts the thing down, as does the `Cancel` link in the hint above the tree, which a pointer or a thumb can reach where a key cannot.
The hint's live region is its sentence alone, so the way out is not read out as news.
While a move is on, every row says in words where the thing would land or that it cannot go there, rather than leaving that to a highlight; a row that cannot take it is `disabled`, which also takes it out of the tab order for the length of the move.

The URL names the open notebook by path, and a move changes that path — for the notebook itself and for everything under it.
So a notebook move rebases the open folder, or moving the notebook you are in throws you out of it and into the first one in the tree.
A note move follows the note only when it is the one open in the editor: a note dragged out of a list the user is reading has left, which is all they asked for, but the note they are *writing in* would otherwise sit beside a sidebar lighting up the notebook it has just left — the same disagreement opening a search result has to avoid.

### The sidebar opens as far as it is asked (2026-10-05)

A notebook with notebooks inside it lists them only while it is open, and a notebook starts shut: a library brought in from elsewhere can be hundreds of notebooks nested three deep, and listed whole the sidebar was a column to scroll to find anything in.
The decision record is [`decisions/0004-the-sidebar-opens-as-far-as-it-is-asked.md`](decisions/0004-the-sidebar-opens-as-far-as-it-is-asked.md).

### Pinned to the top (2026-10-05)

A notebook or a note can be pinned, from its `⋯` or a right-click on its row: "Pin to top", first in the menu, and "Unpin" once it is.
The decision record is [`decisions/0005-pinned-to-the-top.md`](decisions/0005-pinned-to-the-top.md).

### A notebook lists what is inside it (2026-10-07)

A notebook's list shows its own notes, then the notes of every notebook inside it, at any depth.
The decision record is [`decisions/0009-a-notebook-lists-what-is-inside-it.md`](decisions/0009-a-notebook-lists-what-is-inside-it.md).

### Where the user is, in the URL (2026-10-06)

The hash names the place the user is, a slug for each name, so the title says where they are and Back and Forward work.
The decision record is [`decisions/0007-where-the-user-is-in-the-url.md`](decisions/0007-where-the-user-is-in-the-url.md), and "A dropdown is a step on a phone" is in it.

### Conflict rule (concrete)
Remote wins the original path.
Local content is saved as a new note at `<path minus .md> (conflict <YYYY-MM-DDTHH-mm>).md` with the same frontmatter except a fresh `id`.
Both appear in the UI; a small banner links to the pair.

The stamp is UTC and minute-resolution, with the `:` replaced — a colon is illegal in a filename on Windows and rejected outright by several provider APIs, and a copy the provider refuses to store is the lost edit this rule exists to prevent.
UTC so two devices in different zones name the same conflict the same way rather than producing two copies that look hours apart and unrelated.
A minute is not unique enough on its own, so a second conflict on the same note inside one minute gets `-2`, `-3`, and so on; the comparison is case-insensitive, because Drive, Dropbox and macOS all are.
The name is deliberately **not** slugified: the copy has to be recognisable as the note it came from and sort next to it.

The names are `packages/core/src/names/conflicts.ts`; the copy's contents, with its own `id`, are `packages/core/src/sync/conflicts.ts`.

### Edits the editor has not saved yet
"Local dirty" is the `dirty` flag, and an edit reaches it only when autosave runs, up to 2 s after the keystroke.
Until then the row is clean, and a pull may replace its body or delete it.
The store cannot see the edit, so the save decides instead (`saveNoteBody`, `apps/web/src/store/notes.ts`), with the same outcomes as the table above:
- **The note's origin.**
  `bodyOrigin` is a fresh random token each time a body is written in from outside the editors: a pull, an import, or the remote side of a conflict.
  Edits made here leave it alone.
  - It is a token rather than a count, so a note deleted and written again in one batch can't come back matching an origin an editor still holds.
  - A file that changes only frontmatter keeps the row's body and origin, so a tag or title changed elsewhere, or our own push completing, is not a conflict.
    The body is compared both as stored and as read from the row's own file, so a note that had no frontmatter until this app wrote it doesn't count as changed.
    `serializeNoteFile` puts a blank line after a new block, which reads back as part of the body, on that pull and every later one.
- **What an edit carries.**
  Each editor remembers the origin of the body it holds: the one it opened with, or the last one it adopted (`useIncomingBody`).
  A body with a new origin is always adopted, even when its text is something the editor wrote or was shown before, as in a remote revert, and the editor then forgets its own earlier saves.
  The editor's origin moves only once it actually holds the body.
  If the rich editor can't parse it, the old origin stays and it is asked again.
  Every edit carries that origin, plus the note as shown when it was typed.
- **Autosave never merges edits from different origins.**
  An edit typed before a pull is saved on its own, before an edit typed into the pulled text replaces it.
- **Same origin:** the save is written as usual.
- **Different origin** (the body was replaced): the edit becomes a conflict copy beside the note, written from the note as the user had it, with their frontmatter and the title their text gives it.
  The note keeps the pulled text.
  If the text is identical, nothing is written.
- **Note gone** (deleted by a pull): the note comes back as shown, holding the edit, dirty, with no `remoteId` and a `write` queued, so it is re-created on push like any dirty note deleted remotely.
  If a pulled file has taken its path, it takes the conflict name beside it.
- **Note deleted here:** the edit is written into the tombstone, which stays deleted, whatever the origin.
- **A save that fails is said, and kept.**
  `flush` calls `save` at once, every time, whatever is still being written — a mode switch or a delete that follows has to find the write begun, and on `pagehide` there is no later; ordering is the store's, since IndexedDB runs overlapping transactions in the order they were opened.
  A rejected save is held and the note view shows an alert until nothing is.
  A retry round happens on each flush and every 10 s while the editor is mounted: it writes what is pending first, then retries each failed edit once, oldest first.
  A failed edit is let go as soon as a newer one issued for the same note, in the same sitting, stands for it, so an older body is never retried while anything newer exists — retried on its own it comes back through the live query as a body the editor may adopt over newer text.
  A sitting ends when the editor's text is replaced from the stored body (another note, a mode switch, a body adopted from a sync pull or another tab): text typed after that does not contain an edit that never reached the store.
  An edit from an earlier sitting or another origin is never merged; if something newer was issued for its note it is saved as `displaced`, beside the note as a conflict copy.
  Deleting a note forgets what is held for it, so a retry cannot bring back a purged row; a note deleted from this tab by any other route (its notebook, from the sidebar) is remembered for the life of the tab (`store/deletedHere.ts`), and an edit to a vanished row is let go rather than brought back when the note is one of those, or the edit is a displaced one.
  A note seen here again — a live row at a save, a file a pull brings in under that id — is no longer one of those: another device restored it, and an edit to it that finds it gone later is kept.
  A body adopted while something was still pending flushes it as overtaken, which is saved as `displaced` whatever is issued after it: it was typed into the text that has just been replaced.
  Known limit: a displaced edit that reaches a tombstone, or a purged row, is dropped — it takes a failed save, a rebuilt editor and a delete together.
  There are no retries after unmount, and a save that fails only at the unmount flush is still lost silently.
- **A newer build in another tab ends this one.**
  Dexie answers `versionchange` by closing with auto-open left on, and the next operation reopens against the newer database without an error — so old code goes on writing into a store a newer build has migrated, and where the newer schema lacks something the old build declares, the old tab bumps the version and puts it back.
  The app instead finishes what autosave holds (bounded at 2 s, since the other tab's upgrade is blocked until this one closes), closes for good, and puts the tab behind a notice offering Reload (`store/staleTab.ts`, `StaleTabGate`, outside the router so the error screen cannot replace it).
  The notice can be put aside with "Copy my text first" — a failed save's banner says to copy the text out, and a block over the page made that impossible — after which a bar goes on saying the tab cannot save.
  The same check runs on every open, not only on the event: a tab that was not open when the upgrade happened (back-forward cache, a dropped connection, an old build from a stale cache) hears nothing, and Dexie opens it against the newer database without an error.
  That tab closes at once and finishes nothing: the newer schema is already live, and what the editor holds would be old code writing into it — it stays on screen to be copied out.
  A `versionchange` with no new version is a delete, not a newer build, and is left to Dexie.
  A tab whose own upgrade is blocked says so after a second rather than hanging.
- **A frozen tab lets go of the database (2026-10-10).**
  Reported on a phone: with the app open in a browser tab as well as installed, the installed app showed its notebooks and the notes' openings but opened no note, and said "Syncing…" with no count, until the tab was closed.
  Chrome freezes a tab hidden for a minute: its timers stop, and so do the answers to its IndexedDB requests.
  A BroadcastChannel message still reaches it, and its handler runs — Chrome 155, seen on Android and on the desktop — and that is how Dexie tells the other tabs of a write, re-running their live queries.
  So each write elsewhere had the frozen tab ask for reads whose answers it could not take, transactions that never finished and held their tables (`chrome://indexeddb-internals` showed them Running, every request done, for minutes).
  The next write any other tab made to those tables waited behind them, and every read there behind that write: the sync's, whose transaction takes in `prefs`, and the open note's.
  What was already on screen stayed, which is why only opening anything failed.
  Chrome's own guard does not reach it: it holds off freezing a tab whose transaction blocks another's, but these start after the freeze and block nothing until the next write comes.
  Now the tab closes its connection on `freeze` with auto-open left on (`store/frozenTab.ts`), Chrome's own advice for the event.
  A live query re-run while frozen asks for an open, which holds no table, and runs once the tab is resumed, through the check on every open above.
  A tab out of date is left closed, and is not closed early while it finishes its writes; nor is one still opening, since Dexie says a database is open as soon as the connection is there, upgrade still running, and an open closed then finishes with no connection and never asks for one again.
  A transaction already under way as the freeze comes is not helped, since a connection closes only once its transactions are done.
  **What it costs:** a frozen tab no longer holds up a newer build's upgrade, so it resumes as one of the tabs above that were not open for it, and where the newer schema has dropped a table or an index this build declares, its reopen puts it back before the check can stop it.
  Before, its connection held the upgrade up until the tab let go of it.
  A schema version that only adds, as each must ("A schema version only adds", above), is untouched by either.
- **Delete can be undone for about ten seconds.**
  The shell keeps the note as it was deleted, including text the store never confirmed, and shows a notice with Undo that does not take focus (`DeletedNotice`; also a palette command while it is up).
  While the tombstone exists, undo restores it — the queued delete withdrawn, a write owed.
  Sync pushes a delete within seconds and purges the row, so past that the note is made again from the kept copy: same id, dirty, no `remoteId`, a write queued, a conflict name if its path has been taken — and in the source it was deleted from, not whichever is showing by then, since the notice outlives a change of source.
  If that source has been let go inside the window, the note is restored under it all the same.
  A tombstone the remote was still owed is one of the things a detach keeps; where the whole source went, its row is made again detached to hold the note (`ensureDetached`, reason `interrupted`) — never the device's own pile, which nothing shows while another source is connected.
  Where the user moved what the source never sent into another one, the tombstone was dropped rather than carried, and the undo follows the move (`movedRows`) and brings the note back there, which is the only place the device still has for it.
  The notice then says the note is back in a source that is disconnected, to be reconnected or downloaded.
  A note restored from its tombstone keeps its path, as the remote does in a conflict (its file is still there), and whatever took the name meanwhile — compared folded, as every writer compares — moves to a free one beside it.
  Undo is one transaction.
  The kept text is what autosave still held unstored once every save had come back, asked for by note: a save that went into a conflict copy is stored, and is not offered again.
  Where that text is older than something stored after it — an edit held from before a body arrived from outside, and typed over since — it is not the note's body: undo brings the note back as it was stored and keeps the held words beside it, as a conflict copy.
  Deleting waits for the saves that were out, so the note is closed only if it is still the one showing by then.
  A body a pull put into the tombstone meanwhile is never overwritten; the kept text goes beside it.
  A failed undo keeps the notice up until it is dismissed.
  A second delete replaces the notice and the first stays deleted.

**Still open:**
- A dirty note that the engine resolves as a conflict while an edit is pending gets two copies: the engine's, holding what had been saved, and the save's, holding that plus the pending edit.
  Nothing is lost, but the second contains the first.
- Copies made by a save are not counted in the status line's conflicts, which comes from the engine.
  The copy appears in the note list, and the open editor shows the pulled text.
- A note another tab deletes, pushes and purges before this tab's live query hears of the delete looks the same as a remote delete, so the note comes back.
  That errs toward keeping the words.
- Two tabs typing into the same note is not covered: edits never change the origin.

### What the loop above left open, and how the engine answers it

The branch table is the specification; these are the cases it does not mention, each decided in the direction that cannot lose an edit.
They live in `packages/core/src/sync/engine.ts` and, for the push, in `packages/core/src/sync/push/`.

- **A file that is not a note is mirrored, and never read as one** ("Pulling files", above); anything at a hidden path is ignored.
  The app owns the folder but not everything in it: a PDF the user dropped beside their notes would be corrupted by being read as markdown and written back, and `.notesapp.json` is our own bookkeeping.
  Two separate checks, because the marker happens to satisfy both and would otherwise hide the loss of either.
- **Same bytes, new version → adopt the version, do not conflict.**
  This is our own write coming back, or two devices that saved the same thing.
  Keeping the old version would make the next push send an `expectedVersion` the remote has moved past, manufacturing a conflict over a file that already agrees with us.
- **A move reported as a deletion plus an entry** — which is what Dropbox and Graph do — must not act on the deletion.
  Applied after the move it deletes the note outright, and which order they arrive in is the provider's business.
  A remote id the batch says is somewhere *else* has been moved, not deleted.
- **A deletion is settled by a write-back only if the write pointed the note at a *different* file.**
  A note is written back by an entry about the very file a deletion names all the time — our own push echo arriving beside the other device's delete, which is what a rename here plus a delete there looks like.
  Reading "this batch mentioned the note" as settled drops the deletion for ever and leaves the row pointing at a file that no longer exists; the next queued move for it can then never succeed, and the ordered queue strands every op behind it.
  Asked of the *file*, the two cases separate cleanly.
  A deletion carrying no id names no file, so there it stays a question about the note, and the provider is asked whether the file the note now points at is there: a rename queued here adopts the version without reading a byte, so the write-back says nothing about whether the file outlived the deletion behind it, and a note kept on suspicion points at nothing for ever.
  Only "not found" lets go of it; any other failure fails the pull.
- **Alive elsewhere, not alive anywhere.**
  A batch routinely carries the state of a path before it was removed: our own write coming back, and then the other device's deletion of that same file.
  Reading the earlier entry as evidence the file survived drops the deletion — and a deletion dropped here is dropped for ever, leaving a row that points at a file nobody will ever mention again.
  The rule that entries are deduplicated to the last one about a thing applies here too: only an entry at a different path, or a later one at this path, says the file is still there — and an entry elsewhere counts only if it came after the thing was last listed at this path, since a round read whole carries a history (moved to `A`, back to `C`, deleted at `C`).
  Where the batch has already carried the note or folder to the path the deletion names (edited at `B/c.md`, `B` renamed to `C`, `C/c.md` deleted), only an entry after the deletion does.
- **A move may or may not change the version**, so the path is followed on both routes through the decision.
  Dropbox's `rev` survives a move; OneDrive's `eTag` does not.
  **And followed from where the batch has the note, not where the store last saw it.**
  `A` renamed to `B`, a new `A` made, and `B/x.md` moved back to `A/x.md`, all in one round: the folder's rename carries the note to `B/x.md`, and the file's entry names the very path the row still shows.
  Compared with the row, that reads as nothing having happened, so the pull reports `ok`, the cursor moves, and the note sits under the folder's new name over a file that is not there.
  Its next write then finds nothing at the path, finds the file by id, finds no rename of its own to follow, and blocks the ordered queue.
  The same holds for a file gone by the time it is read: whether the entry "would have moved" the note is asked of the batch too.
- **The version a move hands back is not the note's until its bytes are known.**
  A move changes no bytes, so it is tempting to keep the version it returns — but that is the version of the file as the move *found* it, and the engine has read nothing.
  Another device can have edited the file since this one's pull.
  Held as the note's own, the new version says "in step" about text this device has never seen: the pull skips the file as the version it already has, and the note shows old text until the file next changes; and a write checked against it is checked against the other device's edit, passes, and overwrites it with no conflict anywhere.
  Every provider had this, the ones whose version survives a move included — there the version handed back *is* the other device's edit.
  So after a move (`runMove`, and the move `followTheRename` makes ahead of a write) the engine keeps the returned version only if it is the one the note already held (Dropbox's `rev` and Drive's `headRevisionId` survive a move, so an unchanged file costs no read), or if the file, read by id, hashes to the note's `syncedHash` — and then it keeps the *read's* version, the one those bytes were seen under.
  A row with no `syncedHash` uses its own text if it is clean.
  Otherwise the note goes on holding the version it had, which is always safe: the next pull meets a version it does not know and reads the file.
  `followTheRename` fails the write instead of sending it; the file has been moved, the retry finds it at the note's path under a version the note does not hold, and `resolvePushConflict` reads it.
  If it did change, that is an ordinary conflict, which keeps both.
  If it holds the bytes the note last synced, nobody edited it — the version moved because the file did, and the read that would have said so failed — and the write goes again under the version those bytes were read under, rather than demoting the user's edit to a copy beside a file with no other editor.
  A read that fails in `followTheRename` fails the op as itself, so a rate limit is waited out and not counted; in `runMove` the rename has landed, and it is "cannot say".
  A dirty row with no `syncedHash` at all (databases from before v0.1.0) cannot be told either way, and gets the conflict copy: a copy nobody needed, where the other guess is an edit nobody can get back.
  The cost is one download per rename on OneDrive, whose `eTag` a move renews — no more than the pull would have spent on a version it did not hold.
  Graph's PATCH takes `If-Match`, so a `move` with an expected version would make the check atomic and drop the read; not done.
  The two-browser soak found both halves (seeds 578 and 461), where they turned on timing; `tests/sync/overProviders.test.ts` puts the other device's edit exactly where it has to land, over every remote.
- **A deletion that names the file is believed.**
  The rule above it — that a folder alive elsewhere in the batch means its children are not deleted — exists for a deletion carrying nothing but a path, and must not be applied to one carrying an id: the provider knew the file well enough to identify it, and "some folder above it is also in this batch" is not evidence against that.
  A deletion dropped here is dropped for ever, because the cursor moves on and nothing mentions it again.
- **A folder move is addressed by where the folder is now.**
  Renaming `A` and then dragging `A/sub` out of it lands as two entries in one window, and the second decision is reached after the first has already rebased everything under `A`.
  Naming the folder's pre-batch path moves nothing at all and says nothing about having failed, so the notebook keeps a position the remote abandoned until the next cursor reset — and a write into it then fails for ever.
  Same rule as for notes, applied to the one decision-maker that was still asking the store alone.
- **A folder move gets the folder in its way out of the way first.**
  Two folders cannot share a path — the store keeps one row per path — so a move onto an occupied one overwrites that row and merges both notebooks' notes into whichever name survives.
  Which of the two the engine does depends on what the rest of the batch says.
  If the batch also reports the occupant deleted (the user deleted `Archive` and renamed `Archive 2024` onto its name), it is deleted first, which is the order the remote did it in and lets the store cascade its subfolders.
  If nothing says it is gone, it is on its way somewhere else — two drags in one window — and it is moved aside under a conflict name, exactly as a note in the same position is, for the entry that says where it went to move it on from there.
  Deleting it on suspicion would take notes nobody asked to lose.
- **Which folder is in the way is a question about the batch too.**
  By the second claim on a path, the folder standing there may be one an earlier decision moved in.
  Reading the occupant off the store answers with the one that used to be there — and if *that* one is the one the batch deletes, the delete takes the newcomer's notes instead.
- **A folder created and deleted inside one window is forgotten.**
  Both halves arrive in the same batch, and the store — asked as it was before any of it — has never heard of the folder.
  Without counting what the batch itself has just made, the notebook sits in the sidebar with nothing behind it.
- **A remote folder delete keeps the dirty notes inside it**, detaching them so the next push re-creates them, and takes the clean ones and every subfolder with it.
  Which of the two a note gets is decided against the batch as well: a conflict earlier in the same batch hands the local edit to a copy and leaves the note clean, so it goes with the folder rather than surviving it.
  The folder is the user's remote layout; the note is their writing, and losing the second to a change in the first is not a trade worth making.
  The store does the cascade in one transaction, because a provider that reports only the folder gives the engine nothing else to send.
- **Decisions are reached against the store as it was, and applied in order**, so a later decision can be about a note an earlier one has already taken away.
  A provider that reports a folder deletion recursively produces exactly that — the folder, and then each file that was inside it.
  The engine tracks what the batch has already removed and says nothing twice; a note that turns up again afterwards (moved out of the folder in the same batch, or a file deleted and re-created at one path) is written back under the id it already had, so the user keeps one note rather than watching one vanish and another appear.
  Belt and braces: `delete-note` and `detach-note` for an id the store does not hold are defined as no-ops, because a batch that rejects is a batch that is retried for ever — the cursor moves only with it, so a single unanticipated ordering would leave the user with a sync that never recovers on its own.
- **One note per path, and one `remoteId` per note, once the batch has been applied.**
  A note of ours can be sitting exactly where a remote one is about to land — two devices both writing an `Untitled.md` offline is the ordinary way to get there.
  Left alone, the two share a path: the sidebar shows one row twice, the queued write for ours eventually lands on the other one's file, and both rows end up carrying one remote id — after which `noteByRemoteId` only ever hands back one of them and the other is stale for ever.
  So ours moves aside first, under the name a conflict copy would get, because that is what it is.
  That applies whether or not it has been pushed: a pushed note has no claim to the path either, since the remote has something else there, and it keeps its `remoteId` so the entry saying where its file went puts it back.
  Duplicates are therefore possible *during* a batch, which is why the store must not put a unique index on the path, and must not make room by deleting what is there.
- **Whether a path is occupied is a question about the batch, not the store.**
  By the time a change runs, an earlier one may have moved the occupant out, deleted it, conflicted it onto the remote's path, or carried it off with a folder — and one the store says is nowhere near may be about to be carried *in* by a folder move, which re-lists no children, so nothing else in the batch mentions it.
  Asking the store alone either moves a note that has already gone — which fails the batch, and a failed batch is retried for ever — or leaves two notes on one path.
  So does asking it what names are free: the same folder move can bring in the exact name a conflict copy was about to take.
  More than one note can be in the way of a single file, and each gets a name of its own.
- **A displacement carries the note's queued ops with it**, exactly as a folder move does.
  A queued `move` is the user's rename and its target is the very path the remote has just taken: left pointing there it conflicts on every push and can never succeed, and since the queue is ordered and a dead op stops the drain, every later op for every other note is stranded behind it.
- **A file can be gone by the time we read it.**
  `changes` and `read` are separate round trips on every provider, so a file the feed named can be deleted in between — the other device editing a note and then deleting it inside one cursor window is enough.
  The entry is skipped rather than thrown on: unwinding the pull leaves the cursor where it was, so the next attempt fetches the same batch and dies the same way, and push never runs either because `sync` stops on a pull that is not `ok`.
  Nothing is imported and nothing of ours is moved aside; the deletion arrives as an entry of its own.
  Except for a note held by that very file which the entry would have moved: the deletion, in this batch or a later one, is at the new path, where the note never got to, and one with no id has nothing else to find it by — so the note whose file is gone is let go of there and then.
  At its own path the deletion finds the note, and nothing is decided on the read alone.
  Only "it is not there" is survivable — a refused or broken read is a batch nobody has decided, and moving the cursor past it would skip the changes for good.
- **A file that is not UTF-8 is left alone.**
  Latin-1, UTF-16, a binary named `.md`: decoded anyway it arrives as a note with U+FFFD for every byte that would not read, and the next push, even the app adding an `id`, replaces the user's bytes with that.
  So `read` refuses it (§4), nothing is imported, and **no row holds the id of a file the engine could not read**, so no write or rename from here can land on it once a pull has seen it.
  A clean note whose file became unreadable goes from this device and nothing is queued against the remote — a note the user had deleted included, whose delete is dropped *when the pull sees the file first*: it was of text they had seen, not of these bytes.
  A delete pushed before any pull has seen the re-save still removes the file — `runDelete` asks nothing of it, and a download before every delete is not worth what it would close — which is the window an edit made on another device has always had.
  The dropped delete stays queued until the next push finds no note for it, and a delete names its note by id alone; so a file arriving meanwhile that carries that id — another device's edit to the same note, set aside — is given a fresh one rather than the id a delete is queued for, or the delete would be re-aimed at it.
  A dirty one is cut loose and moved to a conflict name, and its write creates a new file beside the one it could not read; one the user has renamed meanwhile is cut loose and left where they put it, since nothing is in its way there.
  A note never pushed that has the same name moves aside, as for any arriving file.
  A push that meets such a file — in the way of a note with no file of its own, or as the note's own — does the same and finishes in that drain, with no attempt spent and the op counted as pushed, since it reached the remote as a new file.
  Where the conflict name is taken on the remote by a file this device has not pulled (another device setting its own edit aside in the same minute), the create says so and the next name is tried, bounded as a rename's is; the store is moved first and the remote second at each step, so a process that dies between them leaves an unbound dirty note whose write is still queued, never a file no row knows of.
  A note with a readable file of its own elsewhere steps aside still bound to it, as it does for any file that is not its own.
  A probe that only asks whether a file exists takes unreadable as yes, so a rename of such a file is carried out (it changes no bytes) and the pull that next reads it lets go of the note.
  None of it throws, since a pull that throws never moves its cursor and these bytes read the same way every time.
  With no row, every entry for such a file is read again, so the file is picked up as a note on the first pull after it is saved as UTF-8.
  **The rule never turns on the app's own notes, because the app never writes a U+0000**, and that rests on there being two things a push can send and no way for either to hold one.
  A file the app serializes is stripped where it is made (`noteFileContents`), whatever part of the note the NUL was in.
  A `source` kept verbatim came through one of two doors: a pull, where a file holding a NUL is refused before it is a row, or `importNoteFile`, which drops it on the way in.
  In front of both, neither editor's document ever holds one (`editor/shared/noNul.ts`): it is dropped in the transaction that brought it, so that what the editor reports is what the store keeps.
  Stripped only in the store, the save comes back as a body the editor never wrote, is taken for a change from outside, and what was typed meanwhile is saved as a conflict copy of the user's own note.
  `saveNoteBody` and `createNote` strip as well, as the backstop.
  **And it is said.**
  Each such file is kept per connection with the cursor — `syncState.unreadable`, its `remoteId` and the path it was last read at — and the storage panel lists them by path under the sync status, with what to do about it: save it as UTF-8, or delete it.
  Without that a clean note goes from the device with nothing said.
  A record is a `PullChange` (`unreadable`, `forget-unreadable`), so it commits with its batch and cursor or not at all, and only a change to the list is one: a file listed already at the same path is read again and nothing is emitted, so `pulled` counts a file when it is first listed, when it is renamed and when it is let go of, and not every time the feed names it.
  A note moved aside because such a file has its name rides on the record (`movedAside`) and is said in that notice — "a note of yours had that name; it is now at …" — and not as a conflict, which it is not: nothing was edited twice and no copy was made, and the conflicts line is gone by the time the user wonders about the new name.
  Every note the file has moved aside is kept, not the last of them, and the list keeps saying so when the file is later renamed, since nothing else ever explains the name.
  A file stops being listed when it reads — by its id, or by its path, which covers a tool that saves by writing a new file over the old name — or when a note this device already holds is renamed onto its path; when the same id turns up as something that is not a note, or is hidden; when its own entry finds it gone; when a deletion names its id, or, naming only a path (Dropbox), names its path; and when a rescan does not return its id — except a rescan that may be missing things (`uploadDifferences`), which proves nothing gone.
  Nothing clears the list when a rescan *starts*: an interrupted one would leave the notice blank.
  A rename is the same id recorded at the new path.
  A folder's move carries the paths under it along and a folder's deletion drops them, in the store, because a feed that reports a folder alone says nothing of what was in it; a deletion of a folder this device holds no row for drops them in the engine, whether or not it also carries an id, so long as it names a path.
  A path-only folder deletion is **not** taken at its word for what is under it until the engine has ruled out the other half of a move, or a rename told as `old path deleted, folder listed` would forget files nothing in the round lists again; where it is a move, a deletion naming a file at its old path is read against where the folder went, so the file is forgotten only when nothing in the round says it moved too.
  A deletion naming a folder by **id alone** (Graph, for a folder it can no longer place) says nothing at all about what was inside it, so where this device holds no row for that folder its files stay listed until a re-scan does not return them — a notice left standing for a path that is gone, which is the cost of not guessing at a deletion's reach.
  With a row, the `delete-folder` takes them as it takes the notes.
  A push that meets such a file lists it too where the conflict names the file and its path; where the file is known only by the note's id (`runWrite`, `followTheRename`, a note's own file behind another's name) it is left to the next pull, which reads it and lists it where it is.
  **The list is a notice and nothing else.**
  No decision reads it: with no row, every entry for such a file is read again, so a list that is stale, or lost, costs the user a line of text and never a file.
  A file already imported lossily before this rule is not looked for.
- **A batch sees the notes it has itself created.**
  A file created, deleted and re-created at one path inside one cursor window arrives as three entries, and each of the last two has to know what the ones before it did: the deletion is about a note only this batch has made, and the second file lands on a path only this batch has filled.
  The store can say nothing about either — none of it has been applied — so the decisions already taken are read back as rows.
- **A path can be reused.**
  A note is identified by `remoteId`; the path is a fallback, and it is what lets a note created here be recognised when its own first push comes back.
  The one note the fallback must not claim is one whose own remote copy is alive elsewhere in the batch: that note has been moved and the path merely reused, and claiming it would hand two notes each other's contents.
  Nor, found by a model of two devices syncing at random over every provider (`tests/sync/overProviders.test.ts`), four more, each of which hands one device's file to a note that is not its note:
  - *a note the user has renamed onto the path*, not pushed yet — its file is still at the old name, and claimed it forgets that file, which the feed has no reason ever to mention again;
  - *a note whose own file is still there* — unmentioned because unchanged, so this is a different file that took the name.
    The batch usually says when the note's file went (and a full scan, which never says what was removed, is taken on trust); when it says nothing, since a provider need not report the deletion of a file replaced at its path, the provider is asked by id;
  - *a note the user has deleted here*, wherever it stands — written back under its id, the new file is still a deleted note, and the queued delete takes it from the remote.
    Until 2026-10-14 this held only once the batch had removed the note, which a feed does first by reporting the old file gone.
    A full scan never says what was removed, so the note was still at the path and was claimed as a file replaced while the cursor was dead: the other device's note went from the remote.
    Found by the same model over Drive once a long feed became a scan (§5.1, seed 36).
    It was reachable before by a rescan or any cursor reset, only rarely;
  - *a note never pushed, deleted here or clean, whose bytes and frontmatter `id` are not the file's* — the store reports a deleted note clean, and claimed, its queued delete has a file to aim at.
    It moves aside instead.

  A deletion is matched the other way about — by id when it has one, and by path only when it has not, since a deletion whose id we have never seen is about a file that is not ours.
  By path, it is not about a note the user has renamed *onto* the path (often this is this device's own delete of the note that had the name, coming back) but about one renamed *from* it, whose file was there when the rename was queued — ahead of a note at the path that has never had a file, but behind one that has.
  Another device may have moved that file on since, and the queue still names the old path, so the note found this way is let go of only if the provider says its file is gone.
- **A note moved aside does not take the old name of a rename queued here.**
  The file is still there until the rename runs, and the rename may be queued behind the moved note's own write, which then conflicts with it on every push.
- **An id in a file is adopted only if nothing else holds it.**
  The `id` in frontmatter is what makes two devices agree which note a file is, so it is adopted by default.
  But duplicating a file is an ordinary thing to do in a folder the user can see, and the copy carries the original's id: adopting it blindly writes the copy over the note it came from, unpushed edits included, and leaves the two files fighting over one row on every sync afterwards.
  The second file to arrive is a new note.
- **An id names a note within its connection.**
  The id in a file is whatever the remote says.
  A folder copied from one account into another, or an account connected a second time after its notes were copied elsewhere, brings files that name notes a different connection holds.
  While `notes` was keyed by `id` alone that was one key space for every connected source: adopted, the store had to refuse the write (taking the row would take the other account's unpushed edits), identically on every retry, so the cursor never moved; and the workaround — asking the port whether the id was held elsewhere and naming the file's note afresh — had two connections each writing their own id into a shared file, turn about.
  So the key is `[connectionId + id]` (schema versions 4 and 5), as `folders` was always keyed, and the question is not asked: another connection's note of the same id is another row, neither shown to a store nor in its way.
  IndexedDB cannot change a store's key, so the rows go out to a second store in one version and back in the next, inside the single `versionchange` transaction an open gets; a failure leaves version 3 untouched, and a tab still running the old build is stopped by the stale-tab gate rather than reopening against it.
  Every lookup by id says which source: the store functions take a connection and default to the one showing, the editor names the note's own, and the push queue's per-note lookups filter by connection.
  State the UI holds across renders — autosave's held edits, the deleted-note notice, "this note needs raw mode" — is keyed the same way (`noteRef`).
  An edit or an undo that arrives after its note's source was let go finds the row where it was if the remote had not been sent it (a detach keeps those in place), follows it if a reconnect has since taken it home under a new connection id (`store/movedRows.ts` remembers this tab's moves, new id included; a move made from another tab is followed by id), is kept as an unsent note under the source made again if the row was removed with its source (the remote has the *note*, not the edit — `detachConnection` marks nothing in `store/deletedHere.ts`, whose marks are only the user's own deletes, and only under the binding they were made under: `SyncStateRecord.boundAt`), and is **never** looked for under the source showing, nor by id under any other connection than its own — only a note of the device's own pile is, since the pile's rows move once, into the first source bound, and a bind from another tab is not in `movedRows`, which with two sources connected is another account: found there, the text would be uploaded into storage it has nothing to do with.
  A note that has to be made again goes to its own source, brought back detached if it has gone (`ensureDetached`), and never to the device's own pile.
  Rows change connection only in a bind, which is a delete and an add; two notes of one id can meet there (a detached source's rows going home to a connection that has already pulled the same file), and the one arriving is given a fresh id, its queued ops with it, and is otherwise the row it was.
- **One entry per file, keeping the last.**
  Dropbox documents that a path may appear more than once in a batch and that the last entry is the current state.
  Decided twice against the same pre-batch store, one edited note produces two conflict copies wanting the same path — which the store cannot tell apart, and the push then writes one over the other and gives them one remote id.
  Deletions and live entries are keyed apart, both by id, because a file deleted and another created at that path in one batch is two things happening, not one thing said twice.
  Only files: a feed that tells a round in order (`B` renamed to `A`, a file moved into `A`, `A` renamed to `C`) needs the first rename for the file to land anywhere real, and a folder decided twice is a move from wherever the first decision put it.
  A deletion with only a path is kept each time too — `C` deleted, `A` renamed onto `C`, `C` deleted again is two folders — and the second one is about whatever the batch has put at the path since, not the folder the first took.
- **A rename need not re-list what is inside it.**
  The children's bytes did not change, so a provider may report a renamed folder as the folder at its new path plus the old child paths as deleted, with nothing at all about where the children went.
  An id-less deletion of a folder the batch has alive elsewhere is that rename (unless the batch has since put a different folder at the path, which the deletion is then about).
  One *under* such a folder is ambiguous: a file deleted before its folder was renamed reads exactly the same.
  Dropped, the note is carried along and held over a file nobody has; taken, a file the provider never listed again is lost here.
  So the provider is asked — a note's file by its id, a folder by listing where the rename puts it — and only "not found" lets go.
  The provider answers for now, not for where the round ended, so neither a missing parent nor a listing without the folder is taken as proof: the folder goes only when none of the notes under it is found by its id, and those not found are let go of.
- **A round is one batch.**
  From a stored cursor every page is read before anything is decided, and the round is decided once and applied with its cursor.
  Graph asks for exactly that, and page boundaries fall anywhere: between a folder's deletion and the move of a subfolder out of it, whose cascade would take the subfolder's clean notes; between a folder's two renames.
  The decisions already reason about a batch as a whole, so a round over many pages gets the answers one page would.
  The cost: a failure on any page redoes the round from the stored cursor (as a failure before the first page always did), and one round's decisions, note contents included, are held in memory until it is applied — rounds are normally a few changes, and an import of thousands on another device is one round too.
  Deciding stays near the round's size squared rather than cubed: what the store said is kept with the decision that asked, and a note's place is replayed from its own changes and the folders' rather than from every decision.
  Two thousand new notes in one round decide in about a second in the tests, and a test holds the store reads to a few per note.
  A path already in normal form is not split again to be compared, which was most of the cost of a renamed notebook re-listed note by note.
  A scan keeps applying page by page with no cursor until its last, since it reports no deletions until `reconcile` and a first sync of many notes shows as it arrives.
- **A folder's deletion waits for what the round moves out of it.**
  `C` deleted, and later in the round `C/A` moved to `B` (or up to `C` itself): the subfolder's last entry is decided first, then `C` goes from wherever that left it.
  Outermost first, and each entry is decided again in its own turn, which replays the round's history from where the rescue put the folder.
  Folders only — a note moved out has an entry of its own that finds the note by id, and a note with unpushed edits decided twice would be copied aside twice.
  A folder moving up to take its parent's name is moved out of a parent displaced aside, never deleted with it.
  The same holds when the deletion is reached early, clearing the way for a folder made at or moved onto the doomed folder's path.
  A subfolder whose own entry is the decision that reached the deletion — two folders deleted, each one's subfolder moved to the other's name — cannot be decided again, and is moved out beside the folder for that decision to move on.
- **A folder arriving where another is leaving.**
  A new folder at a path whose folder the round goes on to move or delete gets that folder out of the way first, as a folder move does; merged into one row, the move that follows would carry the newcomer off with the other's notes.
  Where the one in the way is the folder the arrival is moving out of (`Z/X` moved up to `B` while `B` is renamed to `Z`), the arrival is asked where it is again after the displacement.
  A folder that is not mentioned again stays merged, as before.
- **Two notes meeting at a path neither ends up at.**
  A folder rename can land a note on a path another note has just arrived at, when the round goes on to rename the landing note elsewhere.
  Displacing either leaves a conflict copy of a note that never conflicted, so the landing note is left to its later entry.
- **A conflict copy is named against the folder the note ends up in**, not the one it came from, and avoids every name the batch is bringing in, every name already in the store, and every name the batch has already chosen — one entry can need both a displacement and a conflict copy, and both are named from the same path.
  Two devices syncing on the same interval conflict inside the same minute, so the copy one of them made arrives in the very batch that decides to make the other; landing on the same name overwrites the edit the copy exists to save.
  Naming it against the old folder is the same bug in a different direction — the old folder may be one this batch is deleting.
- **A full scan reconciles, folders included — and only once it is all in.**
  A scan says what exists, never what was removed, so after a `CursorResetError` every note deleted while the cursor was dead would come back, and a notebook deleted then would sit in the sidebar for ever with nothing behind it.
  Notes and folders carrying a `remoteId` the scan did not mention are treated as remotely deleted; anything never pushed is left alone.
  Two things make this the most destructive rule in the file.
  It runs on the last page only, because no page before it has seen everything and reconciling against one would delete nearly the whole store — and the pages after would put a note back at each path, so the app would look right and every note would be a different note.
  And it exempts whatever the same batch has just re-established: a file replaced at one path while the cursor was dead leaves the row carrying the *old* `remoteId`, which a scan that only saw the new one never mentions.
- **A scan sweeps up only what the batch has not already settled.**
  Reconciling names the notes a scan never mentioned, and a `delete-folder` in the same batch names none of the notes it cascades over — so without asking where each note stands once the batch has run, the sweep deletes them a second time.
- **The app folder is never a folder row, and never a folder change.**
  Several providers report the root as an entry of its own — Graph's `delta` returns the root item.
  There is nothing above it to hold a row, and a row for it would be reconciled away after the next cursor reset as a folder the scan did not mention.
  Since every path is within the root, that one `delete-folder` is every note on the device.
  Guarded where the row would be made and again where it would be deleted.
- **A deletion of the app folder itself is ignored.**
  An adapter that reported the root by mistake would otherwise wipe every note on the device in one batch, and if the folder really is gone it is the connection that needs attention, not the notes.
- **A note that changed while it was being pushed stays dirty.**
  The outcome handed to the store carries the exact bytes that were sent, and the store clears the flag only if the note still holds them.
  Otherwise the last thing the user typed is marked as saved and never sent.
- **A failed push stops the queue rather than stepping over it.**
  The queue is ordered because later ops depend on earlier ones — a write into a folder whose `mkdir` failed would land nowhere, or resurrect a folder on a provider that creates missing parents.
  An op that has failed five times is surfaced rather than retried.
  Writes sent together are met in queue order once all of them have answered: those that landed are done, and the first that did not is handled as if it had gone alone, with the others that did not behind it — so a rate limit or a failure stops the drain where it would have, and what landed beside it is a write, which nothing behind it waits on.
  A rate limit among them is the one handled, wherever it came: handled behind a conflict, which lets the drain go on, it sent the rest straight back through the wait the provider asked for.
- **A queued row that fits no kind is read as `malformed`, kept, and failed (2026-10-26, #447).**
  `SyncOp` is a union by `op`, each kind with the fields it cannot be sent without (`noteId` for a note's ops, `targetPath` for a move, `fileId` for a file's, `remoteId` for a `delete-file`), and the web store reads each row through a schema of those (`toSyncOp`); the rows themselves are as they were, and every release since 1.0 has queued each kind with its fields.
  A row that fits none — a move that lost its target, a kind a later version queued — used to reach the engine as whatever it said it was: a move with no target threw, and a kind this version does not know ran as a note's write.
  It is read now as `malformed`, never thrown on, so the rest of the queue still reads, and never dropped: the engine fails it like any op that cannot be sent, and at five failures it stops the push and says why, as the ordered-queue rule has any op do.
- **Same bytes, new version is not a conflict on the push side either.**
  An interrupted push looks exactly like one: the write reached the remote and the store could not be told before the tab closed, so the op is still queued carrying a version the remote has moved past.
  Conflicting would hand the user a copy of the note they already have.
- **The op that hit a conflict is finished, not re-queued.**
  Its content is preserved in the copy; replaying it would overwrite the remote with the very bytes the user has just been handed a copy of.
  Only a `write` is answered this way: a `move` that finds its target occupied and a `mkdir` that finds a file in the way carry no two versions of anything, and resolving them would point the note at somebody else's file.
  They fail, and stop the queue like any other failure.
- **A push that finds nothing at the path asks whether the file merely moved.**
  `write` is addressed by path, so a file renamed remotely reports exactly what a deleted one reports, and §7's answer to a deleted file — re-create it — would leave the user with two notes where they had one.
  The engine reads by `remoteId` first; if the file is gone it re-creates, and if it is still there it asks *who* renamed it.
  A remote rename is left for the next pull to rebase.
  A local one — the user edited and then renamed, so the queue is a write and then a move — can never resolve itself: no pull will move a note over a rename the remote has not heard of, and the ordered queue cannot reach the `move` while the `write` in front of it is failing.
  The queue is what tells the two apart, so it is asked, and the rename is performed there and then.
- **A move whose file is gone is finished, not retried.**
  Nothing will make it succeed, and failing it blocks the ordered queue for ever over a rename — the least of what the user has waiting behind it.
  The note keeps its contents, and the pull that reports the deletion cuts it loose or takes it away.
- **A transient failure is a status, not a rejection.**
  Offline, a 500, a store that could not commit: the batch rolled back and the cursor did not move, so `pull` answers `retry` exactly as `push` does.
  That covers every store call, not just the batch — reading the cursor and reading the queue are store calls too.
  Rejecting instead would make every caller wrap `sync()` in a `try` to discover something `status` exists to tell them, and one that forgot would take the app down on a flight.
- **A locally deleted note keeps its row until the remote copy is gone, and every read sees it.**
  The queued `delete` carries a note id and nothing else; the `remoteId` it needs lives on the row, so the row *is* the tombstone.
  A store with a `deleted` flag and filtered indexes is a natural reading of "every live note", and it loses a note the first time one is deleted here and edited on another device: the pull cannot see the row, mints a second note at that path, and the queued delete then removes the file that was just imported.
  Where both happen in one window the delete wins — the row is written back by the pull and purged by the op behind it.
  That is a decision, not an accident: the delete is something the user did, and the remote change may be their own from the other device.
- **A push is addressed by where the note is now.**
  A pull between queueing an op and running it rebases the note and leaves the op's own `path` behind.
  Invisible where `remoteId` identifies the file, and the whole address where it does not (WebDAV, deferred).
- **A move with no target fails rather than being marked done.**
  It is a store that lost the column, not a move with nothing to do, and completing it would discard the user's rename with nothing said anywhere.
- **Nothing is reported that did not happen to the user.**
  A deletion that matches no note, file or folder we hold — a file at a hidden path, a file never imported — is not news, and counting it puts a number in front of someone for an event that was never about them.
- **A folder move clears the notes in its way, not just the folder.**
  A cascade keeps a dirty note and merely cuts it loose, so a deleted folder can leave notes behind at their paths with no folder row above them.
  Moving another folder onto that path then drops its notes on top of theirs: two rows at one path, which the sidebar shows twice and which the next push has overwrite each other for ever.
  The local note is displaced to a conflict copy — the remote keeps the path — at whatever depth under the destination it sits.
- **A folder deletion says which folder, not which path.**
  Two drags in one cursor window name one path and mean two folders: delete `A`, rename `B` onto `A`, delete `A`.
  Matched by `remoteId` where the provider gives one and by the row that was at the path where it does not, and answered with the position that folder ends up at once the decisions in front of it have been applied.
  A deletion dropped here is dropped for ever, because the cursor moves on and nothing says it again.
- **Two files deleted at one path are two deletions.**
  Keyed by `remoteId` rather than path, so a file replaced and then removed inside one window does not fold into a single event that lets go of only the second.
- **An entry is not matched by path to a note the batch has already moved.**
  A folder rename carries every note under it and the feed says one word about the whole subtree, so the store still shows the note at its old path.
  A different file arriving there would otherwise be written into it, while its own file goes on existing under the new name.
  A note the batch merely *removed* is still matched: it has nothing of its own left and becomes the arriving file, which is what keeps one note rather than two when a path is reused.
- **A `move` that reports not found asks which end was missing.**
  A provider answers the same way for a file that is gone and for a destination folder that was never created, and a note dragged into a notebook made on this device hits the second every time — nothing queues a `mkdir` for a folder that has only ever been moved into.
  The folder chain is created and the move retried; only a genuinely missing source finishes the op.
- **A conflict discards the losing edit's queued write.**
  That op carries the content the copy now holds, and the note itself holds the remote's bytes.
  Replaying it puts the remote's own content back under a new version, which every other device pulls as a change that changed nothing — and which can lose a race against a real edit made in between.
  The user's rename is left queued: the conflict rule is about content.
- **A rescan names the outermost vanished folder only.**
  `delete-folder` cascades, so naming a nested one as well is a second delete of a row the first has already taken.
- **A rescan names a vanished folder by where its row ends up.**
  A scan is one batch like any other, and a `move-folder` decided in front of it has already rebased the row; naming the pre-batch path deletes nothing and leaves the notebook the remote no longer has in the sidebar under its new name.
- **A note the rescan only moved aside is still a note the rescan did not find.**
  Moving ours out of the way for a file arriving at its name says nothing about the file our row holds — a scan can do that without ever mentioning it.
  Exempted from the reconcile on the strength of the displacement, a clean note whose file is gone keeps its row and a dead `remoteId` until the next scan, and what the user is left with meanwhile is a conflict copy of a note that never conflicted — a scan being the only thing that can put it right, and one that need not come for weeks.
  So the exemption covers what the batch wrote back or took away, and a note it merely displaced is asked after like any other: its own file among what the scan returned is what keeps it, and nothing else.
  A dirty one is cut loose and keeps its edit, as everywhere else.
  **Not on a rescan that uploads**, and not because absence proves less there — that rescan acts on absence all the time, by sending the note back up.
  It is sending a *displaced* note back up that is wrong: `reupload-note` strips the row and queues a create-only write at the note's path, which by then is the fresh conflict name the displacement gave it, so the create cannot fail the way it would at the note's own path, where a file that was there all along conflicts and puts itself right.
  It simply lands, and the user has two files where they had one.
- **Every batch-aware question about notes includes the ones the batch has moved by name.**
  A folder is not the only thing that carries a note somewhere: a `move-note` brings one in from anywhere at all, and its row is still at the old path in the store.
  Missing it means nothing is displaced when a second file lands on the same name — two rows at one path, which the sidebar shows twice and the next push has overwrite each other.
- **A write that finds nothing makes the folder before re-creating the file.**
  A provider answers not found for a missing file and a missing parent alike, and the second is the ordinary case of a notebook deleted on another device while a note inside it had unsaved work: the pull keeps that note and cuts it loose, leaving nothing on the remote above it.
  Without this the write fails identically on every attempt and the ordered queue strands every op behind it, for every note.
- **A cascade leaves the notes it keeps a notebook to be in.**
  `delete-folder` takes the folder rows on the way down but not the dirty notes, so the rows a surviving note needs are re-established — at the end of the batch, because whether a note is still there is not known until the batch is over.
- **A rename the user has queued is not undone by our own echo of it.**
  The feed cannot say whose rename an entry describes; the queue can.
  Moving the row back undoes what the user just did in front of them and frees the path they renamed *to*, so a file arriving there in the same batch is imported rather than displaced and the queued move then conflicts on that path for ever.
  The version is still adopted; only the path is left alone.
  `followTheRename` asks the same question from the push side, and only about a queued move whose target is where the note now is.
- **A push conflict over a file another note already holds is not that note's conflict.**
  The path is simply taken, by a file whose own row is elsewhere because its rename has not been pulled yet.
  Adopting it would give two rows one `remoteId` — `noteByRemoteId` hands back one of them and the other is stale for ever.
  The note moves aside instead and its write is retried where it now is — unless it has no file of its own left to stay bound to, in which case its edit goes up as a new file at the new name in this drain, as it does for a file that cannot be read.
  **Either way the name is asked of the remote, not of the store alone**, which has never heard of the file another device set *its* edit aside to in the same minute.
  Where the note's edit is being written, the write is the asking and a refusal moves on to the next name.
  Where the note stays bound to a file of its own there is nothing to write — the path belongs to somebody else's file and ours may be perfectly good — so each candidate is read for instead, at a request apiece on a name that is almost always free at the first ask.
  Without it the retry meets that file, steps the note aside again from a name that already carries a suffix (nothing strips one back off), and leaves `x (conflict …) (conflict …).md` behind having spent a second of the op's five attempts with the ordered queue stopped.
  A read by path is no more proof than a listing is on a provider that hides what the app did not make (§5.1); what it settles is the case it is for, since the file in question is one another device of this app wrote.
- **A queued rename onto a path the remote will not give up lands beside it.**
  A `move` is not a `write`, so the conflict rule has no second version to reconcile, and nothing will ever free that name: left queued it fails on every attempt and strands every op behind it over a rename.
  The remote keeps the path and the rename takes a conflict name, where the user can see what became of it.
- **A directory the user's notebook left is removed by an op of its own, and only when five things agree.**
  The notes' moves and deletes go up first; the `rmdir` behind them carries the folder's `remoteId` as the queue recorded it.
  It finishes without deleting anything unless all five hold: the provider's listings are the whole truth about a folder (`listsEverything` — see the bullet below; where they are not, the other four stand before the folder is *left* instead); it has that id at all — without one the folder it is about cannot be told from whatever holds the name now; the store has no folder row at the path and no live note at or under it — the user made the notebook again, or a pull brought it back, and it is a folder to keep; the parent's listing has a *folder* at that path whose id is the one recorded — a folder renamed or replaced elsewhere is not ours to remove, and only the id says which it is, since the name alone is the same either way; and a walk of the folder finds no file anywhere beneath it, hidden files and files this device has never pulled included.
  The walk goes one subfolder at a time and stops at the first file: it is the only walk in the engine whose depth the user chooses, and in parallel a deep notebook would put an unbounded number of listings at the provider at once.
  Not found at any step is finished rather than retried: the folder is already gone.
  - The row check is exact where the note check is "at or under" because every path that makes a folder row makes its ancestors too (`ensureFolderChain`, and the memory store's `putFolder`), so a row under the path cannot exist without one at it.
  - **Known gap:** a file written into the folder between the walk and the delete goes with it.
    That lands in the provider's trash or recycle bin on all three, and on Dropbox in deleted files, so it is recoverable — but this device will not report it.
  - **Known gap:** a notebook deleted while its own `mkdir` is at the network leaves the directory behind.
    The answer arrives to a store with no row at that path, so the id has nowhere to go and no `rmdir` can name it.
    It shows up as an empty notebook after a re-scan.
- **A folder is removed only where a listing can prove it empty.**
  Deleting a folder takes everything under it, seen or not, so the `rmdir` above never deletes on a provider whose `list` is not authoritative: `StorageProvider.listsEverything` is false on Google Drive, where `drive.file` shows the app only the files it made and a PDF the user dropped into the notebook through drive.google.com is invisible (§5.1).
  There the directory stays.
  Until 2026-10-13 so did the notebook — on every other device at once, and on this one after a re-scan — as the cost of not trashing a file the app cannot see.
  Now the op *leaves* the directory instead (`leaveFolder`), past the same gates: it is marked, nothing in it is touched, and the adapter does not report it while it holds nothing the app can see (§5.1, "A folder the app has left").
  True on Dropbox and OneDrive, which give the app its own folder and everything in it, and delete.
- **A dead `rmdir` is given up on rather than surfaced.**
  Every other op that runs out of attempts stops the queue and asks for help (the ordered-queue rule below), because what is behind it depends on it.
  Nothing depends on an `rmdir`: it tidies an empty directory away, and an empty notebook nobody asked for costs the user nothing next to every note they write from then on waiting behind it.
  So at the limit it is completed, and the directory stays.
- **A folder this device is removing is not made again by our own echo.**
  A sync pulls before it pushes, so the round after a notebook's deletion routinely carries the `mkdir` this device's own push landed, reported as a folder that exists — which re-creates the row, and the `rmdir` behind it then finds the store holding the notebook and finishes without removing anything.
  A folder change is dropped when a queued `rmdir` holds its `remoteId` *and* names the path the entry is at.
  Scoped to the path, because the same folder renamed by another device meanwhile is a notebook to keep at its new name, and a folder that device made fresh at the name we are removing is not the one the queue is about.
- **A folder deletion with no id is not about a notebook the remote has never heard of.**
  Dropbox reports a deletion as a path and nothing else, this device's own included — so the round after an `rmdir` lands carries the deletion of a name the user may well have made a notebook at since, which is the ordinary sequence of deleting a notebook and making another with the same name.
  Matched by the path alone it deletes the row the user has just made and cascades over what they have put in it, while the `mkdir` queued behind it makes the directory again, and the two fight every round.
  A row with no `remoteId` is one no `mkdir` of ours has landed on, so no deletion of ours can be about it — strictly, a row `ensureFolderChain` made for a directory the remote does have is id-less too, and is now beyond the reach of a path-only deletion until a pull reports the directory and gives the row its id; the alternative, deleting by name, is the notebook-the-user-just-made case above — and nothing else at that path can be either: whatever the batch has put there arrived after the deletion was recorded.
- **A notebook the remote no longer has does not take the notes whose files were never in it.**
  A note is in a notebook here as soon as the user moves it there; its file moves when the queued `move` runs, which may be days later if the device is offline.
  Another device removing that directory meanwhile is reporting something true — the directory is gone — but it says nothing about a file that was never inside it.
  Cascaded over, the note's row goes with the notebook while its file stays on the remote with nothing here naming it, and since the cursor has moved past that file nothing mentions it again: the note is gone from this device until a re-scan.
  So a `delete-folder` carries the notes the cascade must leave alone (`keep`), read from the queue — the same place that says which renames are the user's — and a rename left in the queue makes the directory again at the far end when it runs, as every push does.
  A note whose file *is* inside the directory is taken as before.
  Found by the two-device soak, at seeds 378, 427 and 591 of 600.
- **A notebook gone before its `mkdir` was sent withdraws it.**
  Queued and sent, that `mkdir` makes a directory on the remote that this device can never ask to have removed: the row it would read the id onto is gone, so no `rmdir` can name it, and the next pull that reports the directory makes the notebook again, empty — the very thing the `rmdir` exists to prevent.
  So a delete or a rename withdraws every queued `mkdir` at or under the path it is leaving, and a notebook renamed twice before a sync sends one `mkdir`, for the name it ended at.
  The notes' own ops stay: a note in there may have been moved out rather than deleted, and a write that finds no parent makes it.

- **A rate limit is not an attempt.**
  An op stops being tried after five failures, and a provider refusing every request while a quota resets would spend all five in half a minute on an op there is nothing wrong with — the user's note, blocked, with every op behind it waiting.
  A `RateLimitError` says nothing about the request, so the engine reports it as a retry without counting it, on the pull side as well as the push side.
  Everything else is counted, including a 5xx: it may be the request.
  The same goes for a rate limit met while *resolving* a push conflict — reading the remote entry the conflict rule needs is a request like any other — so the resolution's own error, not the conflict that led to it, decides which branch the failure takes.
- **Known gap: a rate limit that never ends is never *named*.**
  Nothing counts an uncounted retry, so a provider that answers 429 for ever leaves the op retrying for ever — every five minutes at the least, since the wait is the longer of the backoff (capped at five) and the provider's own answer (capped at fifteen) — and the status says `retrying` with the provider's message rather than naming the op that is stuck behind it.
  Retrying for ever is the *right* answer while the limit is real: the op is fine and the provider will serve us again.
  What is wrong is only that it is never named, which matters most for the cases that do last — Drive's daily quota, or a full Drive answering `RESOURCE_EXHAUSTED` with no reason we can read.
  An attempts-ceiling (after N rate limits in a row, count the next one) is **not** the answer and is deliberately not built: it would block a note over a quota that was about to reset, which is the worse failure.
  The answer that fits is the one `blocked` already uses — a "throttled since" clock beside `blockedSince` that, after some minutes of consecutive rate limits, publishes `attention` with the op named, without ever touching `attempts`.
  That closes the visible half and leaves "a rate limit is not an attempt" intact.
  It is not built yet because nothing in the phase needs it and the threshold wants a real quota to calibrate against; it goes on the live-check list.
- **The provider's own answer for how long to wait wins, but never shortens the wait.**
  A `Retry-After` is the only informed answer to when the remote will serve us again, so the scheduler waits for it — but takes the longer of it and its own backoff, since a one-second `Retry-After` on the fifth failure in a row is not an invitation to come straight back.
  Capped at fifteen minutes: Drive's daily quota says a day, and a device asleep past any horizon the user can make sense of looks broken.
  Coming back sooner costs one request refused the same way, and the wait starts again from what it says then.
  The cap is also the ceiling on what a *misread* header can ask for, which is the half of its job that is easy to lose: `parseRetryAfter` (`packages/core`) takes the longer of two values `Headers.get` has joined, and `Date.parse` will make a date out of most things, so a malformed `Retry-After` can cost fifteen minutes and never more.
  Anyone weighing raising the cap, or dropping it, is weighing both.
- **A tombstone owes the remote its delete and nothing else.**
  `queueWrite` refuses to queue one for a deleted note, and `queueDelete` withdraws the writes already queued for it.
  Both halves matter, and the second was missing: a note made and deleted before either op was sent still had its write run, so the file was created and then removed.
  That is only waste while the path is this device's own — but a path is not.
  Another device that made a note of the same name meanwhile finds a file there when its own write runs, binds its note to that file rather than making one, and loses it when the delete behind it lands.
  Nobody deleted that note, and it is gone from every device.
  A queued **move** is not withdrawn: the file is still at the name it had, and while every provider the app syncs to deletes by id, the queue is not the thing that should be deciding that.
  A write already at the network loses its queue row only, which is what `completeOp`, `failOp` and now `resolveConflict` all tolerate: the file it creates is still recorded on the row, so the delete has the `remoteId` it needs.
- **A stuck op is named, with the path the user gave it.**
  "Some changes could not be sent" leaves the user with nothing to act on, and the queue is ordered, so the first op out of attempts is also why everything behind it is waiting.
  The status carries that op — what it was doing, the path (a rename's destination, which is the name the user is looking for), how many attempts, and what the provider said — and the panel offers to open the note it is about, where the note is still there.
  There is no "discard": dropping a queued write leaves a dirty note that never syncs.
- **A rescan that uploads.**
  A scan says what exists and never what was removed, so reconciling treats a note it did not return as deleted.
  That is right when the provider's copy is the authority — but a provider can say it is not.
  Graph's `resyncChangesUploadDifferences` means "Upload any local items that the service didn't return", which is what a server-side restore answers, and there the scan looks exactly like a user who deleted everything: trusted, it deletes every clean note on every device that syncs after it, quietly, and the words are gone.
  So a `CursorResetError` carrying `uploadDifferences` starts a rescan that **infers no deletion from absence**.
  Each note the scan did not return forgets its `remoteId`, `remoteVersion` and `syncedHash`, is marked dirty and is owed a `write`; each notebook the store had bound to a remote folder forgets its `remoteId` and is owed a `mkdir`, outermost first and ahead of the writes this rescan queues.
  Not ahead of every write: a *dirty* note's write was queued when the user typed, so it has a lower `seq` than anything here and still makes its own parent through `runWrite`'s not-found recovery, which this does not make unreachable.
  This is the one place a pull marks a note dirty, against §3's rule that only a user's editing transaction does: the row genuinely is ahead of the remote now, and the unsynced dot the sidebar paints on it is true until the push drains.
  A deletion the scan *proves* still stands — a file it listed that is gone by the time the engine reads it is a positive answer, not an absence, and is still forgotten.
  A note the user deleted here is left alone entirely: its tombstone is reported clean, so the scan names it for reupload, and the store declines — it owes the remote its delete and nothing else, and forgetting the `remoteId` would leave that delete addressed at nothing and the file back on the next pull.
  A notebook the store holds with **no** `remoteId` is not named either: the reconcile asks only about folders bound to a remote one.
  An empty local-only notebook therefore stays local-only, as it was before the rescan; one with notes in it is made by the writes of the notes inside.
  Forgetting all three matters: a write against a `remoteVersion` for a file that is not there is refused, and a kept `syncedHash` says these bytes are already up, so nothing would ever send them.
  No folder cascades, since the notes inside are named one by one — the cascade exists to stop notes floating at a path with no folder, and here neither is going anywhere.
  A note the scan *did* return with different bytes needs no special case: a clean note's bytes are what it last synced, so the remote's are the newer ones, and a dirty note takes the conflict rule as always.
  The flag survives an interruption for free — the stored cursor is left in place, so the next pull meets the same refusal and is told the same thing.
- **Reading everything again is offered, with what it costs said first.**
  A cursor the provider has lost, or a store that disagrees with the remote about what is there, is otherwise a dead end the user cannot get out of.
  "Re-scan from scratch" drops the cursor and gives every op its attempts back, in one transaction so a scan cannot start against a half-reset queue, and keeps `rootId` — it is the same folder.
  The confirm says what a scan means: notes the provider no longer has are removed here too, unless they hold edits that have not been sent.

**Renames of notes holding unpushed edits, on providers with file ids.**
A note renamed remotely *while it holds unpushed edits* arrives under a new path, and — on OneDrive, whose `eTag` changes on a move — a new version too, which on its own reads exactly like a remote edit.
So every note records `syncedHash`, the `contentHash` of the bytes it and its remote file last agreed on: set by every pull that writes a note (`upsert-note`, and a conflict's remote side) and every push that lands (`pushed`, whether or not the user typed meanwhile — the remote holds what was sent), passed on `adopt-version` and `move-note` (read afresh when the version moved, carried over when it did not), and dropped with the remote (`detach-note`, a deleted folder's dirty notes, a copy into another account, a note brought back from a pull's delete, a note restored while its delete was in flight).
A dirty note whose remote file's bytes hash to it — read at the version the feed named, since a read that answers with another version proves nothing about that one — was not edited over there: the engine follows the rename (`move-note`) or takes the version (`adopt-version`), the edit stays dirty and goes out against the new version, and no conflict copy is made.
A note with no hash — rows from before it existed — cannot say, and takes the conflict as it always did, so nothing is migrated.
WebDAV is not helped: its `remoteId` is the path, so a rename arrives as a deletion and a new file, the dirty note is detached and re-created on push, and the renamed file becomes a second note — nothing is lost, but the user sees two.
The engine computes every hash and the store only writes it, since a Dexie transaction cannot wait on `crypto.subtle`.

**Search is a question, not a place.**
Every note is already on the device, so search is answered here and nothing about it goes near a provider or `apps/api`.
Not by Dexie either: IndexedDB indexes whole keys and their prefixes, so it can find a title that *starts with* what was typed and nothing else — a word in the middle of a body is invisible to it, and a scan for a substring would rank nothing and miss "meetings" for "meeting".
So the words are indexed in memory, by MiniSearch, over the title, the tags and the body, with the title and the tags weighted above the body.
Prefix and a light fuzziness are on, because the last word is still being typed and a plural is not a different question; a second word narrows rather than widens, since that is what typing more means.
The index is built when a search opens — as the field takes the cursor, not at the first letter (2026-10-08, "Large libraries") — follows the notes while it is open — it is fed from a live query, so a note edited in another tab moves in the results — and is let go when the field has neither the cursor nor a query: the words of every note are a second copy of the corpus, and carrying one for a feature nobody is using is a cost nobody goes looking for.
Rebuilding costs one pass over the rows, and a row whose indexed fields have not moved is left alone, so a keystroke costs the search and not the corpus — the search, and at most fifty matches, because a short query can match every note there is and each one renders a row.
A match's excerpt walks its body, so it is made as its row is drawn, where a draw that a later letter has overtaken can stop between rows.
The list says when it is showing fifty, so the answer to a list that is cut short is another word rather than a scrollbar.

Two things the highlight has to get right, both of which were wrong first.
It marks the words *the index* matched, not the words that were typed — a prefix or a fuzzy hit means the two differ, and marking what was typed leaves the actual match plain — and it marks them longest-first and only where a word begins, or `meet` paints itself inside "meeting" and `he` inside "there".
The query is cut into words by MiniSearch's own tokenizer rather than by a rule of ours, since a query split differently asks for terms that were never indexed.
What is dropped from it is a one-letter *piece of a word the tokenizer broke up* — the `t` of "don't", the `e` of "e-mail" — which is a letter nobody typed as a word, and which with prefix matching on matches most of the notes there are and most of the words inside them.
The unit is the chunk the user typed, and that distinction is the rule: dropping every one-letter word instead made "plan b" return exactly what "plan" returns, against the promise two sentences above that a second word narrows, and made a single-character CJK word unsearchable beside any other.
And the excerpt is centred *tightly* on the match and wraps over a few lines rather than being one clipped line: the column is a little over forty characters wide, so a generous run-up put the highlight reliably past where the line clips — the one thing the row exists to show, off screen, with every test still green, because jsdom has no layout.

**The answers hang from the field, and choosing one ends the search (2026-09-23).**
They used to take the notes pane over — and, in a compact window, the notes dropdown — which left the notebook the user had been reading hidden behind a query, and a chosen answer left the query standing, so the field stayed active and the pane stayed a search until it was emptied by hand.
Now `SearchField` is a combobox with its own listbox, the pattern the command palette already uses: the cursor stays in the field, the arrows move the highlight, Enter opens the highlighted note, a press on a row opens that one, and Escape or a press outside puts the list away.
On a wide screen the list is a card under the field; in a compact window it fills everything under the bar, as the compact panels do — the first version of search in a narrow window capped the list at 14rem and gave it 60dvh, which left the result count at the mercy of the viewport's height, two of four on a 320×568 SE, and filling the space has none of that arithmetic.
Choosing an answer opens the note, empties the field and takes the focus out of it, and in a compact window gives the bar back to its dropdowns, so a phone's keyboard goes with the list.
The notes pane is only ever the open notebook's notes, and making a note no longer has to clear a search to be seen in it.

**Before anything is typed, the list is the notes opened lately (2026-10-15).**
A press on the empty field — or the compact bar's search icon, which puts the cursor there — lists up to eight notes opened on this device, newest first, under "Recently opened", in the same rows as the matches less the excerpt, since nothing was asked of them; the first letter makes it the search, and emptying the field brings it back.
The owner's choices: **every source**, as search is, each row naming its source while there is more than one, and choosing one from another source taking the user there as a match does; **notes only** — a scratch card or a password item opened is not one, since a card is glanced at more than opened and a password's label in a list shown on every press on the field is said more often than one a search was typed for; and **not the note on screen**, which there is no going back to, so Enter on the list goes to the note before it.
The list is a row of `prefs` (`recentNotes`, `store/recentNotes.ts`) holding the twenty opened last as source and id, so a note renamed or moved keeps its place and no title or path is copied; the notes are read from it, a deleted one or one gone from the device left out, only while the field has the cursor.
It is the device's and is not synced, as where the user was is not (`lastOpen`): two devices are two people's reading, or one person's in two places.
A note is put at the head of it as it becomes the one open, whichever way that happens — a row clicked, a search, Back, the app reopening on it — and nothing is written when it is at the head already, which is what reopening the app asks.

**The layout follows the window, in two steps, and everything inside it follows its own room.**
Wide, it is three columns: 15rem of notebooks, 19rem of notes, and the note, with a 13rem outline inside the note view.
Below **1250px** the two side columns narrow together, as `clamp()`s whose `vw` terms meet their full widths at exactly 1250px, so the note keeps the room it would otherwise lose.
Below **60rem** the window is compact: the source tabs and the `+` become one dropdown — the sources as a list at the top, under a header laid out as the notebooks' is, its `+` opening the same providers the tabs' `+` does, and the storage panel at the foot, as it sits at the foot of the sidebar; each source's row ends in a `⋯`, as every notebook's and note's does, the showing source's holding what the storage panel's gear holds beside the tabs (syncing now, re-scanning, downloading every note, importing, stopping on this device, disconnecting) and another's showing that source first and then doing what was chosen there, since the scheduler syncs only the source in front and its questions are asked in its own panel; each begins with Rename, every source's but this device's, its row becoming the field as a notebook's does (2026-10-02; a phone had no way to rename one before, since on a tab it is a second press on the name and a row in a panel is a place to go) — so the panel there only says how syncing is going, and what is asked about once one of those is chosen (2026-10-01) — the notebooks and the notes become dropdowns beside it showing the open one's name cut to fit, the search becomes an icon that takes the bar over while it is in use, and the rich editor's toolbar is hidden until the note's `Format` button asks for it, and then sits below the note, where the thumb is, with its menus opening upwards — and stays, on this device, until it is asked away again, a reload included (2026-10-02, `prefs`; it went with every reload, so a user who wanted it pressed `Format` each time the app opened).
Its menus open in the top layer (`popover`), over the note's title and the bar, no taller than the room above their button in what can be seen — the visual viewport, which the keyboard shrinks and a phone may pan — and scroll inside themselves past that (2026-10-02): hung in the page, they were clipped by the editor, the note and the shell, and with the keyboard up the first items of `More tools` were cut off under the note's title, out of reach.
All three fill the window under the bar and scroll inside themselves: a panel sized to its content left a strip of note beneath it, too short to read and easy to press by mistake.
The notebook and note dropdowns are not copies of the columns: they are the sidebar and the note list themselves, positioned as a panel under the bar and kept mounted while shut, so the notebook menu and a move's destinations work in a compact window without a second implementation.
Each trigger is its words and a chevron, with no box, as wide as its words — the source's is its mark and a chevron (2026-10-04, below) — and the three read as a path: each chevron is as far from the next trigger's words as from its own (2026-10-02; each had a third of the bar, which on a phone set short names far apart).
Once the bar is full, a short name keeps all of its width and the long ones share what is left, each cut to fit — the three are a grid's tracks rather than a row, which would cut every name in proportion to its length, so that one long title took "Work" down to "W".
The notebook's says its path, as the notes' heading does, so a notebook inside another says which it is in (2026-10-07; it said the notebook's own name alone).
Short of room it is shortened in its middle (`middleEllipsis`): the notebooks it is in give way first, from their end (`Work/Proj…/Q3`), and once its own name no longer fits whole both ends give way, the end keeping more (`Work…d budgets`).
CSS has no middle ellipsis, so it is measured — by a canvas, scaled to the width the page laid the whole path out at — and the whole path stays in the label unseen, so the bar's grid sizes the trigger by it as before.
The note's name is shortened the same way (2026-10-07), cut alike from both ends (`Forecas…ond half`), since its end is what tells two notes that start alike apart; the source's, a mark, is never cut.
The chevron points along the bar while the panel is shut and turns down, on a tile in the "on" colour, while it is open, and the panel opens out of its trigger — from a strip as wide as the trigger, right under it, out to the window — and shuts back into it, so which of the three was opened is never in doubt.
**While a panel is open, the triggers after its own say nothing (2026-10-13, asked for on a phone):** the sources open, the notebook's and the note's are hidden, and the notebooks open, the note's — or a scratch card's name — since what they would say is what the panel is there to choose, and a source being chosen has no notebook yet.
They keep their room, so opening a panel moves nothing along the bar; they fade as it opens and are back as it shuts, and are `inert` meanwhile, so a press where one was is a press outside the panel (`afterOpen` in `components/shell/CompactBar.tsx`).
The triggers before the open one's stay, as the path to it, and go to their panels as before.
**A choice in one panel opens the next (2026-10-02):** a source chosen opens the notebooks, and a notebook its notes, so a phone goes from an account to a note in one pass; a note chosen shuts the dropdown on it, and so does a notebook with nothing in it at any depth, where a note begins and is what shows (`useBegunInView`).
A notebook whose notes are all in notebooks inside it opens its notes as any other does, since they are its list (2026-10-11): it was taken for one with nothing in it, so no dropdown opened, and a phone showed a note from a notebook inside it that the user had not chosen.
Going straight from one panel to another — so, or by another trigger — the two slide along together rather than one shutting into its trigger as the other opens out of its own, since the triggers are in a row and the panels are in the same order: onward, the one left goes off to the left and the next comes in from the right, and back, the other way.
Where the triggers are is measured in the bar and handed to the shell as custom properties, since each is as wide as its name and the search field may or may not be beside them — measured again when the bar's width changes or any of the three names does; a user who has asked for reduced motion gets the panel at once.
Back shuts the open panel, and goes back through the panels a note was chosen from (§7, "A dropdown is a step on a phone").
No row in the notebook or the note dropdown is lit as the one open (2026-10-10): the notebook and the note it would mark are under the panel, out of sight, so the lit row read as one pressed or picked out, and the bar says what is open; `aria-current` still says it to a screen reader.
The source's row still is, since its trigger is only its mark, which does not say which account is open.
A press anywhere outside the open panel shuts it, except on a menu or a dialog drawn over the app (`createPortal`): nothing outside the panel can be pressed to open one without shutting the panel first, so one that is open came from it, and what is chosen there — a rename, a delete — happens in the panel.
The storage panel moves from the sidebar's foot to the source dropdown there, since that is the one about storage — and the palette's commands that live in those components still find them.
The widths are decided in one place, `components/ui/layout.ts`, and reach the stylesheet as `.compact` on the frame rather than as a media query of its own, because the compact width also decides which bar is *rendered*, and two answers to that question could disagree by a pixel and show the sidebar as a column and a dropdown at once.
A test holds the stylesheet to having no width media query.
Renaming a source is the one thing a compact window does not offer; on a tab it is a second press on the name, and a menu row has no room for the name to become a field.

**Each source shows which storage it is (2026-10-04).**
A mark in front of its name, on its tab, on its row in a compact window's source dropdown, and on each provider the `+` offers (`components/sources/ProviderIcon.tsx`); and on a compact window's source trigger, the mark alone, the name staying in its tooltip and in its name for a screen reader (`Source: Work`), since on a phone the name took the room the notebook's and the note's need.
A name says nothing about where the notes are once the user has given one ("Work").
The marks are the providers' own, in their own colours and unaltered, as each one's brand rules ask, fetched from each vendor rather than redrawn: a mark in this app's line style would be one nobody knows at a glance, and a glance is the whole of what it is for.
Google's Drive logo (2026) is published as images only, so it is Google's PNGs at the sizes Google draws for 16 and 24 points, chosen by `srcset`; Microsoft's OneDrive icon (2025) is the SVG Microsoft draws for 17px; Dropbox's glyph is the path on its brand site, in Dropbox Blue.
Each is an `<img>`, so a mark is drawn exactly as published, the gradient ids in one copy cannot meet another's, and nothing in it reaches the page.
This device's notes, a source that no longer says whose it was, and WebDAV have no mark and get a line glyph in the text's colour, a laptop and a cloud.
The sources and links are in the component; the marks stay the vendors' trademarks (§13).

**Inside the window, each part goes by the room it has, not the window's width.**
The same window gives the note very different room with the columns beside it and without them — a 1000px window leaves the note 35rem beside the columns, and a 900px one, compact, leaves it all 56 — so a rule keyed to the window hid things that had room for them.
What only changes how something looks is a container query: `.note-view` is a container, and its header keeps to one row — the path narrowing first and going below 36rem, the title taking a row of its own below 20rem.
The header's controls are icons, to cost the title as little as they can: the outline and the compact `Format` toggle are pressed while what they show is shown, the two editors are a pair of tabs with the one in use pressed — a single button named for the mode it was in read as the mode it would switch to — and the outline's toggle is at the end: what it opens is the note's, at the right-hand edge.
Moving and deleting the note are in the `⋯` at the end of its row in the note list (2026-10-01; from 2026-09-23 it was at the end of the note's header, and then briefly beside the list's `+`).
**Every row ends in a `⋯` of its own (2026-10-01).**
Each notebook's, after its count; each note's; each source's in a compact window's source dropdown (`RowOptions`), always shown, with the items a right-click on the row gives.
A `⋯` in a pane header, about whatever was open, did not say which item it was about until it was opened.
The row is a button and a drag source, so the `⋯` is its sibling in the row's `<li>`, drawn over the end the row leaves free for it: the row keeps its highlight, its drop outline and its hit area.
It is the size of the header's `+` and as far from the pane's end, so the `+` and the `⋯` under it stand in one column.
A row with nothing to offer — the loose notes, a note begun and not stored, a move under way — leaves the same room or shows its `⋯` disabled, so the rows keep their shape and the counts line up.
**No menu item ends in an ellipsis (2026-10-06).**
A few did ("Disconnect…", "Import files…", "About Google Drive…", "Move to notebook…", the toolbar's "Link…") and most did not, whether or not they opened something before acting, so the mark said nothing a user could rely on.
All the menus now name the action alone.
Buttons in a panel or a dialog that lead to a question ("Discard…") keep theirs.
**The outline is a flyout where a rail would cost the note too much (2026-09-23).**
It used to be not offered at all below 36rem of note, which was every phone.
There, and in a compact window on a touch screen, it now opens over the editor from the right instead of narrowing it, shut until asked for, and shuts again once a heading is chosen, on Escape, on a press anywhere else, or on opening another note: it covers what it is for.
On a touch screen a jump scrolls to the heading and leaves the caret alone, since focusing the editor raises a keyboard over it.
Each keeps its name for a screen reader and in its tooltip, and each is the title's 1.75rem high, so the header's bottom rule still meets the pane headers' beside it.

**Spacing is a handful of variables, and density is setting them.**
`styles/tokens.css` says every step and `styles/` builds every inset from `--space-*` steps and three variables blocks agree on: `--gutter`, how far a block's words sit from its sides; `--bar-block`, above and below the words of a header bar; and `--row-block`, above and below a row.
Every block that holds words takes its inset from `--gutter`, so the words line up down the screen however many blocks they cross — the note's title over its first line and over the toolbar's first label, a pane's heading over its rows, the first tab over the notebooks' heading — and a bar that starts or ends with a borderless control pulls its padding in by that control's inset (`--control-inline`), so it is the words or the glyph that sit on the gutter, not the control's invisible edge.
A compact window sets `--gutter` and `--bar-block` tighter on `.app-frame.compact`, and a note narrower than 36rem sets its own `--gutter` tighter in `@container note`; the bar's height stays, so its rule still meets the pane headers'.
Tests hold the blocks to the variables.
What is on — a pressed toggle, the editor tab in use, a mark already applied — is `--on-bg` and `--on-fg`, in the accent, rather than a darker grey than hover: a grey only a little darker than hover is not told apart from it while the pointer is still over the toggle.
Hover lights only under `@media (hover: hover)`, since on a touch screen `:hover` sticks to the last thing tapped and a toggle just turned off stayed lit; keyboard focus is a ring outside the control, in the accent, apart from its state.
What changes what is rendered, or what a control says it is doing, is measured (`useElementWidth` in `components/ui/layout.ts`), since a container query has no answer a component can read.
It is measured on the first draw with the element and then when the `ResizeObserver` says it changed, just after the browser has laid the page out, never on every draw: measured there, as it first was, it made the browser lay the page out there and then, in a compact window on every keystroke in a note, for the compact bar's width (2026-10-07, #275).
The outline starts open beside a note 53.5rem wide or more (the room a 1400px window gave it beside the columns), starts collapsed below that — an `Outline` button in the header, and a palette command, away — and is not offered below 36rem, where the rail would leave the note narrower than itself; once the user has pressed it either way it stays as they left it for the session.
The compact bar shows the search as a field beside the dropdowns once the bar is 40rem wide, and as an icon that takes the bar over below that.
The formatting toolbar keeps to one line at any width: what does not fit goes into a `More tools` menu at its end — straight after the last tool shown, as close to it as the tools in a group are to each other (2026-10-07; pushed out to the bar's far end, whatever room was left over sat between them, up to a tool's width, and more in the scratchpad's row) — least used first — the code block, the indentation, the rest of the inline formatting, the task list, the lock that makes a secret, the link, the paperclip, the lists, italic, bold — and the text style never, since it says what the cursor is in.
Widths are measured on the bar and remembered once a control has gone, so the bar knows when one would fit again without drawing it to find out.

**Corners, shadows, sizes of words and what is over what are steps too (2026-10-31).**
`styles/tokens.css` names them (`--radius-*`, `--shadow-*`, `--text-*`, `--z-*`).
`--brand` and `--on-brand` have defaults there under `:where(:root)`, which weighs nothing, so the brand's stylesheet wins whichever loads first and nothing else has to spell a fallback.

**ProseMirror's stylesheets sit in a `vendor` layer, and the app's rules in none (2026-10-31).**
They arrive with the editor's chunk, after the app's sheet, so unlayered they would win every tie; unlayered rules beat layered ones whatever their weight.
The app itself stays unlayered, on purpose: `styles/` relies on weight across files (focus rings and hover in `base.css` and `primitives.css`), and layers there would reverse those for no gain.

**Motion is a handful of variables too, and less motion is setting them to nothing (2026-10-06).**
`styles/` times and eases everything that moves from tokens on `:root`, written nowhere else: `--ease-out` for what arrives or answers, `--ease-in` for what leaves, `--ease-glide` for a compact panel crossing the window; `--duration-state` (120ms) for a colour changing, and `--duration-s`/`-m`/`-l`/`-xl` (120, 180, 240, 300ms) for a fade, a menu opening, a dialog or a notice arriving, and a panel crossing the window.
What the pointer lights and what becomes selected or on — hover, a selected row, a pressed toggle, the clipboard's edge — fades over `--duration-state`, through one `:where()` rule on every control; the focus ring does not, being where the keys are, and neither does a highlight the arrow keys move through a list (the palette, the search's answers, the slash menu), which would read as the list lagging.
Everything that opens arrives one way (`@keyframes arrive`): from nothing, a few pixels short of where it rests and a little smaller, towards the control it opened from — down under a button, up over one at the foot of a pane or a bar (`FloatingMenu`'s `rises`, the bar under a phone's note, the selection's toolbar) — menus over `-m`, dialogs and the palette over `-l` as their backdrops dim, notices up from the foot over `-l`.
What appears among rows that have already moved to make room for it only fades: a notebook's own notebooks as it opens, a new clipboard item, the find bar.
Nothing animates on the way out but the compact panels, which were designed to shut into their triggers; a menu, a dialog or a notice is gone as soon as it is done with.
`translate` and `scale` rather than `transform`, so that the arrival composes with an element's own transform and leaves its laid-out size alone; `FloatingMenu` places its card by `offsetWidth`, not by the box it is drawn in while it arrives, which is smaller.
Under `prefers-reduced-motion: reduce` every step but `--duration-state` is `0ms`, so what would have moved is simply there and a colour still fades, a colour changing not being movement; the clipboard's spinner, a loop rather than a step, stops outright.
A test holds the stylesheet to the tokens.

**A finger gets 44px (2026-09-23).**
An audit on a touch phone and tablet found almost every control sized for a mouse: the editor's tabs 24px, the header and pane icons 28–32px, menu, slash-menu and list rows 30–35px, the code-block tools 24px, the task boxes 15px.
Where the primary pointer is coarse (`@media (pointer: coarse)`, in `styles/touch.css`), each is at least `--tap`, 2.75rem, both ways — Apple's 44pt and WCAG 2.5.5 — by setting `--control` and `--control-inline` from it and giving the rest a `min-height`.
Grown in place rather than given invisible hit areas, since most sit shoulder to shoulder; the bars take `--space-2xs` above and below instead, and the note header's gaps close to it, so a phone's header still fits and the three headers still meet.
Two things are smaller on purpose: a task's box is 24px (WCAG 2.5.8's minimum; a list's lines are closer than 44px apart) with the task's words stepped in to clear it, and a link inside a sentence is its words, which 2.5.8 exempts.
A mouse keeps the dense layout at every width.
Fields under 16px were raised to it, since iOS zooms into a smaller one on focus.

The query itself is deliberately *not* in the URL, unlike the open folder and note: those are where the user is and a reload should land there, while a half-typed query is not a place to come back to.
**Known ceilings.**
The corpus is read and indexed in the tab that searches, so a first search over a large library is one pass over every row — 3k notes of ~300 words index in about 150 ms on the reviewer's machine, which is the same order as the ~2k-note cold-start scan above, and it is revisited by persisting the index (or feeding it deltas rather than rows) if it ever shows.
On a phone it is about a second, which is why it is begun with the cursor and built in slices ("Large libraries"); past that, it moves into a worker of its own.
And the tokenizer decides what a word is, which leaves three things unfindable that look like words: it splits on `[\n\r\p{Z}\p{P}]`, so a **tab** is not a separator and `heron\tstood` is one term that neither half finds; a run of **CJK** is one term, so `東京` does not find `東京都に住む`; and a backtick is `Sk` rather than punctuation, so `` `heron `` keeps its backtick, is reached only by fuzziness, and carries it into the excerpt.
All three are fixed in the same place — a tokenizer of our own, given to the index and to `wordsOf` together — and none is worth guessing at before somebody's notes show which matters.

**Commands are declared, not collected.**
Every shortcut and every palette entry is one registration — id, label, chord, whether it can run now, and what to do — held in a registry the shell provides (`apps/web/src/commands/`).
One list serves two things that must never disagree: the keyboard, which runs a command when its chord is pressed, and the palette, which is where a chord is *discovered*.
A shortcut living only in a listener is one nobody can find; a palette entry with its chord typed into the label is one that goes stale the day the listener changes.
Here both come from the same value, so they cannot drift.

Registration belongs to whoever owns the action.
Switching a note between rich and raw has to flush the pending edit first, and what is pending is known only inside `NoteView` — a central list of commands would mean hoisting that state to reach it.
So each screen declares what it can do and the registry holds the union.
Declaring into a registry that is not there is allowed and does nothing, because a screen rendered on its own is not wrong for having nobody listening; *reading* the list without one throws, because `useShortcuts` and the palette exist only to serve a registry, and the shell is where a missing provider shows up.

The keyboard reads the registry when a key is pressed rather than subscribing to it: asking at the moment of the keystroke is the only way to get the commands as they are *then*, which is what a shortcut wants, and a listener that re-rendered on every registration would draw itself again for nothing.
A command is registered again only when what the palette shows of it changes — its label, group, chord or whether it can run — and not for a new `run`, which most callers hand over on every render; the registered command calls the latest `run` (2026-10-29, #455: every render re-registered each command and told the palette).

A command that cannot run now stays visible and is shown as unavailable rather than disappearing.
A palette whose contents move about as the user does cannot be learned, and "why is it not there" is a worse question than "why is it greyed out".
Its chord is still swallowed: letting it fall through to the browser's own `Mod+N` would open a window, which is a stranger answer than nothing happening.

**A chord fires only when nothing else has a better claim on the keystroke.**
Four questions, all in the one listener.
Has something nearer already handled it (`defaultPrevented`)?
CodeMirror's default keymap binds `Ctrl+K` to kill-to-end-of-line on a Mac and calls `preventDefault` while letting the event bubble, so without this the raw editor deletes the rest of a line *and* the app opens the palette over it — and the undo that would put it back is no longer reachable from where focus has gone.
Is it an auto-repeat (`event.repeat`)?
Holding `Mod+E` would otherwise remount the editor several times a second, each remount flushing a pending edit.
Is a dialog up?
While the palette is open every chord is held: a dialog is the app asking for an answer, and a shortcut that fires behind it acts on a screen the user cannot see.
And is the chord *reachable* from where the keystroke landed — which is the bare-key question below.

**The chords are the ones a browser leaves alone.**
`Mod+N` opens a window and `Mod+Shift+N` a private one, in Chrome, Edge and Safari alike, and the page is never asked, so "new note" is the bare key `n`.
Printing a chord that cannot fire is exactly the drift the registry exists to stop — the listener and the label would agree with each other and both disagree with the machine.
A bare key is why `reachable` is there: it is ignored inside an `input`, a `textarea`, a `select` or anything `contentEditable`, and that last case is the one that matters, because both of this app's editors are contentEditable hosts rather than form fields.
An unknown modifier in a spec throws rather than being ignored: `parseChord('Ctrl+K')` read as the bare key `k` would fire on every `k` typed outside a field and print itself as `K`.
Alt is asked the same question as a bare key rather than waved through with `Mod`, because on macOS `Option+<letter>` types a character.

What a bare key costs, and it is accepted rather than unnoticed: every button in the app is a place where `n` now means "new note" — focus the sidebar's "+" and press `n` and you get a note, not a notebook.
That is the price of the only chord a browser leaves alone, and it is small: the surfaces where the key means the letter are exactly the ones `reachable` covers, and the app has no text entry that is not an `<input>` or a contentEditable editor.

Focus returning is decided by where focus *is* when the palette closes, not by whether a command ran.
Asking the second was wrong for every command that does not touch focus — which is most of them — and those are the ones a user runs from the palette and then wants their place back.

**The palette is a dialog, and honours the contract it claims.**
`aria-modal` says the rest of the page is inert, so focus has to agree: the field is the only thing inside that takes focus, Tab is refused, and the rows are `option`s with nothing focusable in them — ARIA gives `option` presentational children, so a button in there is announced as plain text while still sitting in the tab order, which is how focus escaped.
Focus is returned to whatever had it when the palette closes, because removing the focused element does *not* put focus back: the browser drops it on `document.body`.
Unless a command moved it deliberately — `app.search` exists to put the cursor in the search field, and taking it back would undo the only thing that command does.

`Mod` means Cmd or Ctrl and both are accepted wherever it is asked for — on macOS the Ctrl chord is free and on Windows the Meta one belongs to the OS, so taking both costs nothing and a browser reporting a platform we did not expect still gets a working shortcut.
Only the *label* cares which keyboard it is, and it is allowed to be wrong: a wrong label is a smaller failure than a dead key.
Chords without a modifier are ignored while the user is in a text box, or every one of them would be unreachable from the one place people spend their time.

### Getting a library out (2026-09-24)

"Download all notes" writes the source showing as one zip of markdown, from the palette (`app.download`) or the storage panel.
The decision record is [`decisions/0002-getting-a-library-out.md`](decisions/0002-getting-a-library-out.md).

### Getting a library in (2026-10-05)

"Import notes" brings notes in from the user's disk, from the storage panel of the source showing (its gear, or the source's `⋯`).
The decision record is [`decisions/0006-getting-a-library-in.md`](decisions/0006-getting-a-library-in.md), and "Into the scratchpad" is in it.

### The clipboard (2026-10-06)

A clipboard a source's devices share.
The decision record is [`decisions/0008-the-clipboard.md`](decisions/0008-the-clipboard.md).

### The scratchpad (2026-10-07)

Quick notes on a wall of cards.
The decision record is [`decisions/0010-the-scratchpad.md`](decisions/0010-the-scratchpad.md).

### The vault (2026-10-15)

What the app calls the place a source keeps what only its devices can read.
The decision record is [`decisions/0014-the-vault.md`](decisions/0014-the-vault.md).

### Secrets in a note (2026-10-14)

Words the folder holds only encrypted.
The decision record is [`decisions/0013-secrets-in-a-note.md`](decisions/0013-secrets-in-a-note.md), and "Replacing the key", "The device's own lock, where there is one" and "Notes from another source" are in it.

### Passwords in the vault (2026-10-15)

A password manager, kept where the secrets are.
The decision record is [`decisions/0015-passwords-in-the-vault.md`](decisions/0015-passwords-in-the-vault.md).

### Filling in on a site (2026-10-16)

A bookmarklet fills a site's login from the passwords, and remembers one typed there.
The decision record is [`decisions/0017-filling-in-on-a-site.md`](decisions/0017-filling-in-on-a-site.md).

### Large libraries (2026-10-08, #275)

A long list draws only what is near the screen, so a phone can hold a notebook of a thousand notes.
The decision record is [`decisions/0012-large-libraries.md`](decisions/0012-large-libraries.md).

### The app's words (2026-10-07)

Every word the app shows or reads out comes from one catalog, `apps/web/src/i18n/`, rather than being written where it is said, so that a translation is a second catalog and not a change to every component.
The decision record is [`decisions/0011-the-apps-words.md`](decisions/0011-the-apps-words.md).

### Dialogs (2026-10-15)

Every dialog is built one way (`components/ui/Dialog.tsx`).
The decision record is [`decisions/0016-dialogs.md`](decisions/0016-dialogs.md).

### Editor

Two modes over one markdown string.
Default is rich text; a toolbar/shortcut toggle (`Cmd/Ctrl+E`) switches to raw markdown.
The mode is remembered per note and there's a global "default mode" preference.

**Rich mode:** Milkdown (ProseMirror on top of a remark AST).
Chosen because its document model *is* the markdown AST: parse/serialize are the core of the editor rather than an add-on, unsupported syntax stays in the tree instead of being dropped, and the same remark pipeline can serve as the normalizer in `core`.
Presets: `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`; plugins: slash, tooltip (inline formatting), history, listener, clipboard.
React via `@milkdown/react`.
Known trade-offs: smaller community, mostly single-maintainer, React bindings are functional rather than polished, majors have had breaking changes — pin the version.
Fallback if maintenance state or React integration proves a blocker: Tiptap with its official markdown extension, accepting a lossier serializer and relying harder on the fidelity suite.

**Raw mode:** CodeMirror 6 with `@codemirror/lang-markdown`, same autosave path.

**Packaging:** the presets and plugins are taken from `@milkdown/kit`, the aggregate package Milkdown publishes, rather than as a dozen separately versioned dependencies.
Same code, one version to pin — which is what "pin the version" was asking for.

**Menus.**
The slash menu (`/`) and the floating selection toolbar are ProseMirror plugin views written in React, mounted through `@prosemirror-adapter/react` — the adapter Milkdown's own React examples use.
The formatting toolbar across the top of the editor is not one of them: it sits above the text rather than over it, so it is an ordinary component beside `<Milkdown />` that reads the selection through a store the editor pushes to (`editor/rich/format.ts`, Phase 7 polish).
Both offer only constructs the fidelity suites already cover, so nothing reachable from a menu can put something in a note that the file format cannot hold.
On a touch screen the floating toolbar does not appear (2026-10-02): the system draws its own menu over a selection there — copy, look up, share — and the two crowded the words between them; the formatting on a phone is the bar under the note.
It is asked each time a selection is made, so a tablet given a trackpad gets it back.
Picking a command is a user edit like any typed one: it removes the `/query` the user typed and marks the note dirty, which is the point.

**An empty line is a blank line (2026-10-04).**
Markdown has no way to say "a blank paragraph here": a blank line separates two blocks, and three say no more than one.
So an empty paragraph between two blocks is written as one more blank line between them, and read back from how many there are (`editor/rich/markdown.ts`): remark drops blank lines, but every block it reads says which lines it spans, so the gap is still there to count.
Two blank lines between paragraphs are one empty line in rich text, and a file another app wrote with three shows two — as its raw text does.
Only between blocks, and only in what holds blocks — the note, a quote, a list item, a footnote.
One at the start or end of any of them is written as nothing, and blank lines there are read as nothing: the blank line the app writes under a note's frontmatter is the top of its body, and would otherwise be an empty line at the top of every note that has it.
So Enter on the first line of a note, or after its last, is an empty line until the note is opened again; between two lines of writing it stays.

Three things a count of blank lines asks of what is around it, each found in review before it shipped:
- **Two lists either side keep different markers.**
  A list goes on across blank lines, so two lists written with one marker read back as one; the writer alternates them when they touch, and forgets the last marker at any block that is not a list — an empty line too.
  The join between the empty line and the second list puts it back (`blankLinesBetween`), since a join runs after the forgetting and is handed the writer's state.
- **A list is measured by its items.**
  In a quote, remark counts the blank `>` lines after a list as the list's own, so the gap after it measured none; and two or more of them it takes for a gap between items, so a tight list followed by an empty line came back loose.
  A list that holds lines past its last item is loose only where a blank line parts two of its items (`withItemsApart`).
- **A pull that only moves an empty line is a change.**
  Whether the open editor takes in a body was decided by structure, which says nothing of where a block is, so a pull that only added or took out an empty line was ignored and the next keystroke wrote the old spacing back.
  `adoptBody` now compares what the editor would write of the body with what it writes of its document.

It replaced Milkdown's `<br />` on a line of its own for an empty paragraph, the one thing the editor put in a file the user had not typed — the owner asked for it gone, and then for blank lines kept as blank lines.
It was a bijection everywhere but the end: Milkdown wrote nothing for the document's *last* empty paragraph, so Enter in an empty note wrote `<br />`, which came back as one empty paragraph, last, written as nothing — and the fidelity check sent the note to raw mode for the `<br />` it had lost, with a banner naming the HTML `<br />` on line 1.
**Not where the block around it has a word for being empty**: a table cell, which always holds one paragraph, is written empty; and a list item, which begins with one, is written as its marker alone — `-`, `2.` — when that paragraph is empty (2026-10-02; `- <br />` before, which an empty item the author wrote, `-`, could not survive).
An empty first paragraph with more after it is written as nothing, since an item may begin with one blank line and not two.
**One `<br />` is still written:** an empty task item's, `- [ ] <br />`, because GFM writes the box only before a paragraph and `- [ ]` with nothing after it is the words "[ ]".
It is read back as the empty paragraph it stands for, there and nowhere else.

Every other `<br />` is the author's html and stays in the document as an inline atom, written back as it was — on a line of its own as much as inside a sentence, and so also one an older version of this app wrote for an empty line, which shows as `<br />` in rich text and can be deleted there.
Milkdown's own reader (`remarkPreserveEmptyLinePlugin`) took every `<br>`, in four spellings and anywhere in the note, and deleted it — `first<br />second` became `firstsecond`, and the fidelity check below rightly sent the note to raw mode — so it is left out, with its options.
`previewLines` draws a `<br />` alone on a line as no line, below, for the notes that hold one.

It is removed where it is *read*, not where it is stored.
`previewLines` in `packages/core/src/markdown/preview.ts` is the one rule for turning a body into the lines a list can show — the text the rich editor puts on screen, with none of the markdown that put it there: no heading hashes, quote carets, bullets, task checkboxes or thematic breaks, no emphasis characters, a link as its words without its URL, a picture or a file's chip as what it says (a chip with no words, as the file's name) with a space either side — each is a thing of its own on screen, and `coast![Pasted image](…)` read "coastPasted image" (2026-10-03) — a code block as the characters it holds, no block that is only a `<br />`, whitespace collapsed, blanks dropped — and both the note list's preview and the search excerpt are cut from it, so neither can find a different set of words in a note than the other.
It is the text of `previewBlocks`, the same rule with how each line is set kept beside its words — its runs' marks and links, a picture's address or a chip's file on the run that says it, and whether it is a heading, a quote, code, or an item at a depth with its bullet, number or box — which is what a scratch card draws (2026-10-07).
A line that is only a picture with no words is a line there, and none here.
A preview is the worst place to meet the one thing in the file the user did not type: it sits in grey text beside their own words, looking like a mistake they made.

Only a block that is nothing else, which is the only shape Milkdown writes.
A `<br>` inside a sentence is the user's own text — in prose, or in `` `<br>` `` in a note about HTML — and the first version of this removed the tag wherever it appeared, turning "She wrote `<br>` in her HTML lesson" into "She wrote in her HTML lesson".
A rule for hiding what the editor added must not delete what the author wrote.

The note list drops the title from the front of those lines so the row does not print it twice, and it does so by comparing against the title rather than by taking line one.
Position was wrong in both directions: a note beginning with the editor's `<br />` has no heading on its first line and lost a line of real writing, and a note whose heading follows an introduction had the introduction eaten instead.
Between the lines it keeps it puts a pipe (2026-10-01): a row is one line of text, and joined by spaces "Buy milk" over "Call the bank" read as the sentence "Buy milk Call the bank".
A line is whatever the note shows as one — a paragraph, a heading, a list item, a line broken inside a paragraph.
The search excerpt is still joined by spaces: it is a window cut around a match, not a note's opening read from the top.

**It is a parse (2026-10-01).**
Until then it was a pass over the string, and that was measured rather than assumed: the real pipeline — `parse`, then a walk over the mdast — is the same markdown the editor reads and gets every case right, and costs about a millisecond for a 300-word note and 10.6 ms for a 3000-word one, against 0.016 ms for the pass.
The pass won, and what it bought was paid for in syntax left on screen: `**bold**` kept its asterisks, a link kept its brackets and its URL, a table its pipes.
That was reported as the list not looking like the notes beside it — which it did not, since the rich editor shows none of those — and the cost turned out to be one that need not be paid per render.
The app keeps each answer by the body it is for (`apps/web/src/store/visibleText.ts`), so a body is parsed once and an edit is a new key rather than a stale entry.
One parse serves both shapes of answer: a card's blocks are what is kept, and a row's lines are read off them.
**The cache is as large as the lists drawn (2026-10-07, #275):** at least 400 openings, or 1.25 times the longest the note list and the scratchpad have each been, added together so going between them parses neither again (`store/kept.ts`).
A fixed 400 was no cache past 400 rows, because a list drawn again asks for every row in the order the last draw put them out, so every draw — every autosave of the note beside it — parsed every row again.
Whole bodies, which a search answer is cut from, are kept apart and 400 at most, so searching long notes cannot fill the room a long list was given.
**A card's frontmatter is kept the same way (2026-10-07, #275).**
The scratchpad asks every card whether it is named and what its pin and colour are on every draw, and each was a YAML parse: a wall of six hundred cards was some two and a half thousand of them per autosave, since the marks are asked three times a card and their cache of 400 missed every one past 400 cards.
A block is read once (`store/frontmatter.ts`), kept by its text for as many rows as the lists have shown, and `isUnnamed` and `scratchMarks` both read through it.
Both caches are one helper (`keptAnswers` in `store/kept.ts`), which lets go of what was asked least lately rather than what was kept first: a list drawn again asks for every row, so it is what was asked once in between that should go.
And a list row reads only a note's first two thousand characters, cut at a line end, so a long note costs a row what a short one does.
A search still parses whole bodies, since its match can be anywhere: about 52 ms the first time fifty-one 300-word answers are shown, and nothing for the keystrokes after.

**A row says what is being typed, as it is typed (2026-10-01).**
Autosave keeps the store up to 2 s behind the editor, and the list read the store, so a row went on showing the old title and the old opening while the note beside it said otherwise — reported as the app looking out of step with itself.
What is typed is now said to a small store outside React (`apps/web/src/store/liveEdits.ts`) as it is typed, and the row, the name above the text and the compact bar lay it over the stored row for display (`shownNote`).
It is never written anywhere: the note is still the markdown string in the store, and this is only what that string is about to be.
A body typed into a note that has not been named yet names its row from its heading as it is typed, by the same function the save names it by (`titleAfterEdit`), so the row cannot say one thing while it is typed and another once it is stored.
A typed body counts only while the row still holds the body it was typed into (`bodyOrigin`), so a body pulled from elsewhere is never hidden under an edit made to the old one; and each piece gives way to the row once the row has caught up with the write that carried it — by the stored row's `updatedAt`, not by clearing it when the write resolves, which would show the old row for the moment the live query takes to bring the new one back, and not by comparing text, which would let a later edit from another tab on the device sit under an older one for good.
The preview of a body being typed is parsed once and not kept, so typing does not push every other row's answer out of the cache in `visibleText.ts`.
**A notebook's or a source's new name is said the same way, as it is typed (2026-10-02)** (`apps/web/src/store/renaming.ts`): the notebook's row is the field, and the note list's heading, the compact bar's dropdowns and the open note's path lay what is typed over what is stored (`shownFolder`, `shownSourceName`) — they had gone on saying the old name until Enter.
One at a time, since a rename field takes the focus.
A name given stays until the store has it, for the same reason a note's does: a notebook's until the open notebook is no longer at the old path, a source's until the store calls it something other than it did; a rename that fails lets go at once, and the stored name is what shows.

Reading the markdown also retires the guesses the pass made about the user's punctuation: a `#hashtag`, a hyphen inside a sentence and a `1984` that opens one are text because the parser says so, `> > deep` reads as `deep`, and a lone `=` line is an underline only where it is one.

Code is kept as written, because inside a code block none of this is markdown: a `# comment` in a shell example is a comment, a `---` in a YAML sample is a document separator, and a `<br />` in an HTML example is the thing being written about.
A fence that is never closed runs to the end of the note, as CommonMark and the editor both read it.
Indentation inside one does not survive: whitespace is collapsed there as everywhere else, this being one line of grey text and not a listing.
A block of HTML is kept as written too, which is how the editor shows one.

The bias still runs one way: a construct the editor cannot show — a footnote reference, which sends the note to raw mode — is shown as it is written rather than dropped.

**Html shows its character references as the characters (2026-10-14).**
The one thing in html that is not shown as written, in the rich editor (`editor/rich/htmlView.ts`) and the preview alike: `you&rsquo;re` is shown as `you’re`.
A paragraph's references were always read, by the parser; html is handed on as written, so in html they reached the screen as typed.
Reported on a note exported from Google Keep, which puts `<RESPONSE>` directly above the reply.
A tag CommonMark does not know, alone on its line, starts a block of html that runs to the next blank line, so the reply's first paragraph was html, and its `&rsquo;` and `&ldquo;` showed raw while the same characters in a list further down showed right.
Only the references are read (`decodeCharacterReferences` in `core`), with the decoders micromark reads a paragraph's with, so a name it does not know stays as written, and a reference written as `&amp;rsquo;` shows as `&rsquo;`.
The tags, a `**` and a backslash stay as written: that the reply is html and not markdown is what the file says, and is the user's to change in raw mode.
What is drawn is the only change.
The node's value and its `data-value`, which a paste of it is read back from, keep the reference, so the file is written back byte for byte and opening the note dirties nothing.

**Copied out as text, no line ends in a written-out space (2026-10-18).**
A copy from the rich editor puts the selection on the clipboard as markdown, for whatever takes text, beside the html for whatever takes that.
Markdown keeps no space at either end of a line, so the writer keeps one as `&#x20;` (a tab as `&#x9;`): in the note's file that holds a space typed before Enter — a phone's keyboard puts one after every word — and reads back as the space it was.
Pasted into another app it was those six characters, at the end of every item of a numbered list copied out (reported 2026-10-18).
So the copy's text leaves them out (`editor/rich/copiedText.ts`): each line is trimmed at its ends — a block's start and end, and either side of a line break — except in code blocks and code spans, whose spaces are their own.
The note keeps its spaces, and so does a selection inside one run of text, which is copied as it reads, as Milkdown's clipboard plugin copies it.

**Not `@milkdown/plugin-listener`.**
Its `markdownUpdated` is the obvious way to hear about changes, but it debounces on a timer of its own and, more importantly, hands over a markdown string with no way to tell whether a person or the app caused it.
That is exactly the distinction the dirty rule is made of.
A small ProseMirror plugin — the one in `editor/shared/dirty.ts`, which reads transaction metadata — answers it directly, and the serialization happens where the answer is already known.

**Pictures beside a note (2026-10-03, #187).**
Milkdown's image is an `<img>` with the `src` as written, which for `photo-1a2b3c4d.png` is a request to the app's own origin for a file that is not there.
The rich editor draws a picture through a node view (`editor/features/attachments/image.ts`) that asks a host for it instead (`editor/features/attachments/attachHost.ts`), once the picture is within a screen of being seen.
That screen is measured in the editor, which scrolls inside the page; an observer's margin widens only its root, so one watching the viewport saw nothing until it was on screen.
The editor deals only in what the markdown says — a `src`, an `href` — and never in rows, sources or bytes.
The host, one per open note (`components/attachments/noteAttachments.ts`), turns a link into something to show.
It resolves the link against where the note is *now*, so a note that is moved, renamed or bound to a source tells its views to look again rather than rebuilding the editor.
It uses the bytes on the device if they are there, and otherwise reads them from the source (`scheduler.readFile`, §8).
The host is a Milkdown ctx slice, as the slash menu's spec is, because Milkdown builds the node views that need it, not the component that has it.
**A picture with no title is read with the title `''` (2026-10-04).** remark gives it `null`, Milkdown 7.22.1's reader passes that on, and the image schema says a title is a string. prosemirror-model checked that only when a document was checked until 1.25.12, which checks it as a node is made.
So the parse threw, and every note with a picture in it failed the rich editor's check once it was opened again; a picture just put in was made with `''` and was fine until then.
`imageWithoutStrayTitles` reads `src`, `alt` and `title` as strings.
It showed only in the deployment, whose own lockfile had resolved 1.25.12 while this repository's still had 1.25.11.
A deployment that builds this workspace as a submodule resolves its own versions, and this repository's tests vouch only for the ones in its own lockfile.
- **Showing a picture never dispatches.**
  What is shown of a picture is not an edit, and a test spies on `dispatch` to prove it.
  The one edit the view makes is the user's: **Remove from note**, on a bar over the top corner of a picture selected whole, as a chip's bar has it (2026-10-04).
  Reported: on an Android phone a picture tapped, and outlined as selected, stayed put on Backspace, where a desktop deletes it.
  A desktop's Backspace is a key, which the keymap takes; a phone's keyboard edits the text it is shown of the page and says so with an input event, and a picture is no text.
  It did not reproduce in an emulated phone, where every way a Backspace can arrive deletes the picture, so two things answer it: the editor takes any cancellable `beforeinput` that deletes — not a cut or a drag — while a node is selected whole as that node's Backspace (`editor/rich/deleteSelected.ts`, ahead of ProseMirror's own Android workaround, which waits for a change the keyboard may never make), and the bar is there for a keyboard that sends nothing at all.
- **Open full size and Download (2026-10-08, #276).**
  A picture beside the note, selected whole, has Open full size and Download on its bar beside Remove from note, as a chip's file has, through the same `openFile` and `saveFile` (`components/attachments/fileActions.ts`).
  It opens in a tab of its own, in the browser's own viewer (§9), where the browser has one this app may open it in; an SVG, which has none, is saved instead, as a chip's is.
  It is saved under its alt text with its file's extension on the end, since the app writes an alt without one, or under its file's name where it has no alt.
  So whatever size this view draws a picture at, the whole picture is one press away.
  The keyboard works as it does for a chip (`selectedKey` in `editor/rich/nodeBar.ts`): Enter opens it, Tab goes into its bar, and Escape comes back.
  Before this, Enter went to `splitBlock`, which split the paragraph in front of the picture.
  A picture on the web or in the link has only Remove from note, since it is not the note's to hand over, and Enter on it is still the editor's.
- **Drawn from a copy (2026-10-08, #276).**
  The view asks for a picture at the width it draws it, which is the editor's width in device pixels (`ShowOptions.fit`), or for the thumb, which a scratch card asks for (fitting 720×384, a card's 240 × 8rem at 3×).
  The host draws it from the copy of that width, `w960` to `w2560` (`pictureVariant`), wherever a copy is worth having.
  - **A copy the device holds** is drawn at once.
    One it does not hold is made at its turn.
  - **One copy at a time, app-wide** (`copyTurns` and `oneAtATime` in `pictures/copies.ts`): a note's, the scratch cards' and the clipboard's thumbs alike.
    Each original is read only at its turn, since a phone holding forty originals while they wait holds forty pictures.
    Work that nobody is still waiting for at its turn is passed over.
    Work already under way is finished and kept.
    The order is the order asked for, so a note flung to its end waits for the pictures it passed.
  - **A picture just added to the note** is copied the same way, from the bytes the device keeps of it, so nothing is read from the remote.
  - **Where the original cannot be had** (offline, or too large to download unasked), any copy held stands in for it (`nearestCopy`): a copy of another size beats none.
    One too large to download unasked and not on this device says so at once, not at a turn behind every copy asked for before it.
  - **Shown as it is:** an SVG; a picture that moves; one a copy would barely shrink; one the browser refused to copy; anything where the browser cannot make copies (`noShrinker`); and one whose copy was missed this time, which is asked for again the next.
    Where the browser makes no copies at all, nothing waits a turn, and each picture's size is still kept the first time it is read, so that next time its box is held.
  - **Its box is held.**
    The host gives a picture's own size with it (`Shown.width` and `height`), and the `<img>` takes that size whichever copy fills it, so a copy is drawn exactly where the original would be.
    Where the device has read the picture before, the host can say its size before showing it (`AttachmentHost.size`, from the record alone).
    The box is held at that size while the picture is on its way, so the lines below do not move when it arrives.
  - **Not yet:** a window that grows wider than the copy was made for keeps that copy until the picture is shown again.
    A phone turned on its side draws `w1280` across 2,532 pixels until then.
- **Each picture not shown is asked for again:**
  - when the note's path or source changes;
  - when the source's files change;
  - when the network comes back;
  - when a sync has run to the end of a pull.
    A source that could not be read from, its token refused or its account reconnected, can be now.
- **A picture that is not shown says why, in words, after its alt text:**
  - not found beside the note;
  - not downloaded, and the device is offline;
  - not on this device, with its source unreadable now;
  - could not be downloaded, with Try again.
    A host that fails outright, such as a store that cannot be read, is shown this way too, rather than leaving an empty box;
  - not a kind of picture this app shows: anything `showsInline` does not name, a PDF or a HEIC, which is never downloaded only to fail;
  - could not be shown (the browser refused the bytes).
- **Large pictures wait to be asked.**
  One over 8 MiB that the device does not hold waits for Show: a phone on a data plan should not download a 20 MB photo because a note scrolled past it.
  A picture the device holds is shown whatever its size.
  Show is remembered until the link names another picture, so a notice or Try again during the download asks with it rather than putting the picture back behind the button.
  The download, which may be long, says so.
- **Addresses.**
  `https:` and `data:` sources load directly, with `referrerpolicy=no-referrer`, which the copied-out HTML carries too: which note a picture was seen from is nobody's business.
  Any other address is not loaded at all: `http:` (which the CSP refuses anyway), a path from the root, or another scheme.
- **An SVG is drawn from a `data:` URL, never a `blob:` one** (`drawsFromData`).
  A `blob:` URL belongs to the app's origin, so "Open image in new tab" would make the SVG a document that runs script as the app.
- **Object URLs.**
  Every other picture's bytes become one object URL for each copy of it drawn — the original, or a copy of one size (above) — shared by every view that draws that one: one cache for the whole app (`pictureUrls` in `components/attachments/noteAttachments.ts`), so the open note and a scratch card showing the same picture at the same size draw it from one copy of its bytes (2026-10-07, #276; each note's host had its own, and a card open over its note held the picture twice).
  A host going away lets go of only what it handed out.
  It is keyed by the file, *its version* and the copy, so a version the remote has moved on to is another picture.
  It is let go of a few seconds after nothing shows it (`lib/objectUrls.ts`), so a view rebuilt by an adopted body reuses the URL without reading the bytes again.
  A picture already on screen stays as it is until the note is opened again.
  Asking again on every change would blank it, and OneDrive gives a file a new version whenever it moves.
- **The clipboard.**
  The image's DOM rules change, and pasting gains one step:
  - A pasted `<img>` no longer has its `alt` copied into `title`.
    Milkdown's rule turned a picture pasted from a web page into `![a cat](cat.png "a cat")`, with a title nobody wrote.
  - A pasted picture whose source no page can load again (`blob:`, `webkit-fake-url:`, `file:`), such as Word's and Outlook's, is kept as its alt text.
    The words were the author's, and the address points at nothing.
    This does not apply to a picture dragged within the note.
    It also does not apply where nothing else would be left, because a paste that only deleted the selection would be worse than a picture saying it cannot be loaded.
  - A picture beside the note is copied out as `data-src`, not `src`.
    Otherwise, as HTML pasted into another page, it would fire a request for itself relative to that page.
- **The floating toolbar stays away from a picture selected whole:** there are no words in it to format.

**Files beside a note (2026-10-03, #187).**
A link to a file beside the note that is not a picture, `[Q3 report.pdf](q3-report-1a2b3c4d.pdf)`, is a chip in the rich editor (`editor/features/attachments/attachment.ts`): an icon for its kind, its name, and a role of `link` named "Q3 report.pdf, PDF".
It is a node of its own rather than the link mark it is in markdown.
A chip is one thing, selected, dragged, deleted and opened whole, where a link is words that happen to point somewhere, and a cursor in the middle of a file's name has nothing to edit.
- **What it claims.**
  Only a link whose words are one plain run of text, or none, to a relative path with an extension that is not `.md` (`isAttachmentHref`).
  `[*Q3* report](q3.pdf)` stays a link, its emphasis with it, as do a link to a note and one to the web.
  A chip in emphasis keeps its emphasis.
  Milkdown asks every node's markdown rule before any mark's (`ParserState.#matchTarget`, `@milkdown/transformer` 7.22.1), which is what lets the node claim the link first; a test pins it.
- **Written back as the link it was.**
  The name is an attribute, not text, and is written by opening a `link` with one text child rather than through `withMark`, which trims the spaces off the ends of a mark's text, so a name with spaces at its ends keeps them.
  Otherwise a chip is written as every link is once an edit has been made: `[a b.pdf](<a b.pdf> "t")` comes back byte for byte, while `[a](<a.pdf>)` becomes `[a](a.pdf)` and a title in single quotes takes double ones.
  The markdown means the same; only the spelling is the editor's.
- **Opening it.**
  Selected, it shows a bar: Open, Download, Remove from note.
  The bar sits under the chip from its start, or from its end where that would run it off the editor's edge.
  Enter opens a selected chip, and so do a double click and a click with Cmd or Ctrl held.
  Tab goes into the bar, which is the keyboard's way to Download, and Escape comes back to the chip.
  Enter and Tab are an editor prop, asked before every keymap: `splitBlock` would otherwise replace the chip with a paragraph, and in a list Tab would indent the item.
  Mod+Enter stays the task list's, and Shift+Tab the list's.
  A click that opens is claimed by `handleClickOn`, because ProseMirror takes Cmd-click on a node already selected as a click on the paragraph around it and selects that.
  - Open fetches the file whole through the host (`fetchFile`), however large: the user asked for it.
    A file `opensInTab` names (§9) opens in a tab, opened before anything is awaited so that the browser counts it as the press's and not a pop-up.
    The tab is given a `Blob` typed from the name at that point (`safeOpenType`), whatever type the host's `File` came with.
    Any other file is saved, under the name the user knows it by (`downloadName`).
  - On a touch screen, a file being saved, whether by Download or by Open for a type no tab may show, goes to the share sheet when `navigator.canShare` takes it, which is where a phone saves a file.
    If the sheet refuses because the press no longer counts after a long download, the file is saved instead.
  - A file that does not come is said over the page (`useNotices`, the route's toast): not found beside the note, not on this device and offline, its storage unreachable, or a download that failed.
- **Remove from note** is an edit like any other.
  The file stays in the folder, as a link removed by typing leaves it.
- **Links and chips.**
  A link is never put around a chip (`setLink`): in markdown one link inside another is two broken ones.
  A selection of nothing but chips is left alone rather than linked and unlinked again, which would be an edit of nothing.
  The floating toolbar stays away from a chip selected whole.
- **Code is text** (`editor/features/code/codeAtoms.ts`).
  A chip, a picture and inline html are atoms: one position in the document, with markdown of their own.
  Milkdown lost each of them to code:
  - Its code mark's writer writes a node's text, and tells the serializer the node is written.
    Code over a chip therefore wrote an empty code span where the link was, while the chip stayed on screen.
    Now the mark is taken off anything that is not text, in the same dispatch, whatever put it there (Code, Mod-E, backticks, a paste).
    That includes a line break, which went the same way.
    Code over a chip alone is rejected as no edit.
  - A paragraph made into a code block lost every inline node the block cannot hold (`clearIncompatible`).
    Now an atom goes into the block as the markdown it is, `[Q3.pdf](q3.pdf)`, where it was and in the same undo step, by every road to a block: the toolbar, the slash menu, Mod-Alt-C, three backticks.
- **Find in rich text passes over a chip's name,** as it does over a picture's description: a chip is one position, and the bar's matches are runs of text.
  Raw mode finds both.
- **Copied out,** a chip is `<a data-attachment="…">` with no `href`.
  Pasted into another page it is the file's name rather than a link to a file relative to that page, and pasted back here it is the chip again.
- **Until the note is opened again:** a link given an attachment's address with the link button stays a link mark, and is a chip from then on.
  Both write the same markdown.

**Adding a file (2026-10-03, #187).**
A file pasted, dropped or picked into a note goes beside it, and the note links it.
This reverses §1's non-goal and §14's entry, which said attachments were a second kind of object to name, sync, conflict, deduplicate and delete on three providers.
The items of #187 are what doing that took.
- **What is a file.**
  One rule for both editors (`filesToAttach` in `editor/features/attachments/addFiles.ts`):
  - A drop is its files.
  - A paste is its files, unless it carries words of its own.
    Excel, Numbers and Word put a picture of the cells or the text beside the text itself, and what the user copied was the text.
    Words that only name the files, which Finder puts beside a file it copies, are not words of their own.
  - The paste is decided from the event's `clipboardData`, not from the slice ProseMirror has made of it.
    By then a picture the clipboard named by an address no page can load has been turned into its words (`unloadablePicturesInWords`), while the file it came with is still on the event.
- **Adding it.**
  The host's `add` puts the file beside the note (`addAttachment`) and answers the link.
  It is told whether the file was pasted, since a pasted picture has no name of its own.
  - A file over 25 MB is refused before a byte of it is read.
    So is a `.md`, which every device would take for a note (`attachmentRefusal`).
  - A note begun and not stored yet (a draft, `draftNote`) is stored, as its first keystroke would store it, once the file's bytes are read and nothing is left to refuse it.
    A draft stored for a file that never went in would be an empty note in the user's folder.
  - The file goes beside the note it was put in.
    That note is read before anything is awaited, since the host follows whichever note is open now.
  - A refusal or a failure is said over the page (the host's `report`, which the note view gives `useNotices`), in the user's words, naming the file.
- **Rich mode** (`editor/features/attachments/attachDrop.ts`).
  Each file is a placeholder where it is going while it is added.
  The placeholder is a decoration that keeps its place through any edit meanwhile, not the document, so the note is never dirty for a file not in it yet, and a refused one leaves nothing.
  - Once added, each is put in, a picture as a picture and any other file as its chip, one after another in the order they came.
    Each goes in one transaction with no programmatic mark, so the note is dirty and saved as for anything typed.
    It is an undo step of its own, apart from what was typed beside it a moment before.
  - A paste takes the selection at once, as any paste does, and keeps it taken even where every file is then refused: undo brings it back.
    A drop goes where it lands.
  - Either goes beside a block that cannot hold a file (a code block, or between blocks), in a paragraph of its own.
    That is asked again when it goes in, since what it was in may have become a code block meanwhile.
  - Between a table's cells it goes into the text of the cell it is at the end of, or of the first cell where it is before them all.
    Never the next cell, and never a new column.
  - **A picture is never on a line with words (2026-10-03).**
    Put in a paragraph that holds anything else, it goes in a paragraph of its own there: before the paragraph at its start, after it at its end, and between its halves in its middle.
    Several of one paste each get their own, in the order they came.
    It went in at the cursor before, so a screenshot pasted after "Packing list for the coast" sat on that line's baseline and was written `coast![Pasted image](…)`.
    The spaces and line breaks either side of it go, since markdown keeps neither at a paragraph's edge: a space there is written `&#x20;`, and a break is an empty line.
    The cursor is left after it, as after anything pasted, so Enter is the next line; left before it at the end of the words, a second paste would go in above the first.
    A paragraph only: a heading split is two headings, and a table's cell holds one line, so a picture put in either goes where it lands — as does one put at the very start of a list item, whose first line is its bullet's or its checkbox's and the words'.
    A file's chip is a name among the words and stays in the line.
    Raw mode puts the markdown where the cursor is, as typing it would: it is a text editor, and markdown typed there means what it says.
  - The drop is the DOM's `drop` and not `handleDrop`, which ProseMirror never asks where it cannot tell what is under the pointer.
    A drag that began in the note is ProseMirror's to move.
  - A drop cursor shows where it will land, except over a code block: ProseMirror's cursor asks where a drop fits only for a drag from inside the note, so it shows a file going into the code that will land beside it.
- **Raw mode** (`editor/features/attachments/rawAttach.ts`).
  A paste takes the selection at once, as in rich mode.
  The markdown that links the files goes in where they were put, all of one paste or drop together once added, as `input.paste` or `input.drop`, so it is an undo step of its own.
  Where it goes is kept through anything typed meanwhile, and what is typed there goes before it, as before rich mode's placeholder.
  A cursor left there goes after it; one taken elsewhere stays.
  - A drop of nothing but `.md` files is left to CodeMirror, which puts their words in, as it always has here.
    A drop of anything else is no longer CodeMirror's, which read every dropped file as text.
- **Picking one** (`lib/pickFiles.ts`).
  Three ways in: the toolbar's paperclip, the slash menu's Image and File, and the palette's "Attach files".
  - The paperclip is in the Insert group beside the code block.
    On a narrow bar it is given up after the link, since on a phone it is the way to put a photo in a note: there is no dragging there.
  - Each opens the browser's own picker, through a file input clicked inside the press that asked for it.
    A browser opens a picker only for a page the user has just acted on, so nothing is awaited first.
  - Image asks for `image/*`, pictures alone, which a phone answers from its photos.
    File and the paperclip take anything.
  - What is picked goes in as a paste does, in place of the selection, as the user's own edit (`input` in raw mode).
    A picker closed without a choice changes nothing more: from the paperclip or the palette, the note and the selection are as they were.
    From the slash menu, the `/image` typed to ask for it is gone, as it is for every slash command.
  - The palette is the app's, not an editor's, so the editor open now offers itself to the note's host (`AttachmentHost.receive`) and takes itself back when it closes.
    The host keeps every editor that has offered itself and not gone, in order, and the last is the one picked into.
    More than one is there only while one editor gives way to another, and that goes either way round: the new one can be built before the old has gone, and a rich editor let go of while it is still being built is built, and offers itself, before it goes.
    A single slot lost the open raw editor that way: two quick mode switches left the palette saying every pick was for an editor that had closed (found in review).
  - Each pick is its own.
    Chrome queues a picker asked for while another is open, so the paperclip pressed twice is two pickers in turn, and the first one's choice still goes in.
    A pick that gave up on the one before lost that choice (found in review).
    A browser that never says its picker closed without a choice (no `cancel` event; every current browser has it) leaves the input in the page, hidden, until the page is left.
  - An editor closed while its picker was open is an editor closed before its file went in (below).
  - The toolbar says pressed or not only of a button that is on or off.
    The paperclip, indentation and clearing formatting do something, and a screen reader is no longer told they are "not pressed".
- **An editor closed before its file went in.**
  A note switched away from, the other editor chosen, or a page left mid-add.
  - A file already added stays beside the note, unlinked, as a file does when its link is taken out ("Remove from note" above).
  - The files after it in the same paste, drop or pick are not added at all.
  - The user is told to add them again (`closedProblem`).
    The same bytes are the same file, so adding again makes no second copy.
  - Nothing is taken back.
    A withdraw was built first and came out in review (2026-10-03, PR #201).
    It could delete a file another note had just been handed for the same bytes, before that note's save, or another device's identical copy, which an upload already on its way had adopted.
- **Moving a note just written in.**
  The route has every editor save what it holds before it moves a note (`settleEditors`).
  The files that go with a note are the ones its stored body links (`carryLinkedFiles`), so a file pasted in a moment ago would otherwise be left behind.
  Each paste, drop or pick of files is registered while it is under way (`settleAfter`), and settling waits for it first, so a file still being added when the note is dragged goes in and then goes with it.
  The wait is at most ten seconds (`UNDERWAY_WAIT_MS`).
  A file's bytes take as long as the disk they are on, and a move or a disconnect is not kept waiting past that.
- **Anywhere else.**
  A file dragged over the app where nothing takes it is refused (`useFileDropGuard`, §9).

Raw mode shows the markdown, as it always has.

**Links open in the browser (2026-10-12).**
A link was a mark to edit and nothing more; the owner asked for one to be opened.
`editor/features/links/links.ts` holds what both editors and a scratch card share.
- **The chip.**
  While the cursor is in a link, from either end of it as well as inside it, a chip under the link says where it goes — an icon, the site and the page with no scheme and no `www.` (`linkAddress`), and, with a mouse or a trackpad, "⌘+click" (Ctrl off a Mac) — and opens it when pressed.
  Its name to a screen reader is "Open" and the address, and its tooltip the whole URL.
  A selection has no chip: the floating toolbar is the selection's.
  It is shown only while the note has the focus, and a press on it leaves the focus and the cursor where they were.
  - In rich text it is a view of the editor's own (`linkChipPlugin`, `editor/features/links/linkRich.ts`), put in Milkdown's container beside the editable element rather than in the text, so no widget sits by the cursor where an Android keyboard is composing, and inside the box that scrolls, so it scrolls with the words.
    It is placed under the line the cursor is on, from the link's start where that is on it.
    A link is a mark, and its words may be several nodes (`[the **bay** map](…)` is three), so it is found as far as the nodes either side of the cursor carry the same mark.
  - In raw mode it is a CodeMirror tooltip (`editor/features/links/linkRaw.ts`), under the link's start.
    A link is what the parser says is one: `[words](address)`, `<address>`, and a bare `https://…`, `www.…` or e-mail address, which the GFM `Autolink` extension reads as remark-gfm reads it in rich text — only that extension, since the rest of GFM would also change what Enter does in a task list.
    A picture's address is not a link, and neither is a reference's.
- **Cmd-click, Ctrl-click and Alt+Enter** open the link without the chip, in both editors.
  In rich text the click is claimed in `handleClick`, since ProseMirror takes Cmd-click as a click on the paragraph around it and selects that (as for a file's chip), and opened on the click itself with the browser's own answer turned down, so the link never opens twice; a Mac's Ctrl-click is its context menu and comes with no click.
  In raw mode the press is claimed, since CodeMirror would add a second cursor there.
  Alt+Enter is Google Docs' key for it.
- **What opens is an allowlist** (`openableLink`, §9): `http:`, `https:`, `mailto:` and `tel:`, read by the browser's own URL parser.
  Not a relative link: that is a file or another note beside this one, and resolved as a URL it would be a page of the app's own origin.
  Following a link to another note is not built.
- **In a window of the browser's own** (`openLink`): a link with `target="_blank"` and `rel="noopener noreferrer"`, clicked, as a download is.
  An installed app hands a link outside itself to the browser rather than opening it in its own window.
  Not `window.open` with `noopener`, which some browsers take for a request for a pop-up window.
- **None of it is an edit.**
  Nothing is dispatched, and a test spies on `dispatch` to prove it.
- **On a scratch card** a link's words carry where they go (`PreviewRun.href`, in `core`'s `previewBlocks`), and a press on them opens the link rather than the card.
  They are words that say where they go, not a link: the card is a button, and a link inside a button is not one a page may have.
  The card's press asks what it landed on, so the words are positioned, over the press stretched across the card (`.scratch-card-open::before`) that would otherwise be what every press lands on — which jsdom, laying nothing out, cannot see, and the browser showed.

**Source-of-truth rules (these matter more than the editor choice):**
- The note record stores `body` as a markdown string.
  Neither editor persists its own document model.
- Frontmatter is stripped before the body reaches either editor and re-attached on save.
  Editors never see it.
- Switching modes serializes the current editor to markdown, updates `body`, and loads the other editor from that string.
  There is exactly one dirty-tracking path.
- A note becomes dirty only on an editor transaction that changes the document, never on load, mode switch, or re-serialization.
  Opening a note in rich mode and closing it must not rewrite the file.
  This prevents normalization churn on notes authored by other tools.
  A change another plugin makes in answer to one of those — Milkdown's heading ids, `prosemirror-tables` squaring up a ragged table — belongs to whatever it answers: the app's after a load or an adopted body, the user's after a keystroke.
  Appended transactions are attributed by their root; a follow-up a plugin dispatches for itself carries nothing to say what it answered, so edit reporting is held for the length of the app's dispatch and while the view is built (`editor/shared/dirty.ts`).
  Counted as the user's, such a change is an edit nobody typed, carrying the origin of the body just replaced — and it saved as a conflict copy of any pulled note with a heading in it.
- A body adopted from outside (a sync pull, the other mode) is not undoable and empties the undo history, in both editors.
  The editor now shows a different document, and an undo into the old one would be reported as a user edit against the new body and pushed — quietly reverting what someone else wrote.
  Rich mode clears through the meta `prosemirror-history`'s own undo uses, since it has no public clear and rebuilding the state rebuilds every plugin view; a test pins the undo depth at 0 so an upstream change to that shows up.
- On first *user* edit in rich mode, the whole file is re-serialized through remark-stringify, so some normalization (list markers, emphasis style, blank lines) is accepted at that point.
  Configure `remark-stringify` for the most conventional output: `bullet: '-'`, `emphasis: '*'`, `strong: '*'`, ATX headings, `fences: true` with language tag.
  Use the identical options in `core`'s normalizer so editor output and test expectations agree.
- Anything the rich editor can't represent (raw HTML blocks, footnotes, unknown syntax) must survive round-trip as an opaque block rather than being dropped.
  If the parser can't guarantee that for a given note, open it in raw mode with a banner explaining why.
  Checked per note against the editor's own parser and serializer before the user can type, because ProseMirror's schema is a narrower model than mdast and is where a construct would actually be dropped — `core`'s remark suite cannot see that.
  The comparison (`sameMarkdownStructure`) reads a line ending just before inline html as a space, because that is how `mdast-util-to-markdown` writes it — deliberately, so the html cannot be read back as a block — and the two render the same; without that, a `<br />` on a line of its own failed the check in both `core` and the editor.
  **The banner says what, and where** (`components/note/unsupported.tsx`): the check answers with the first node of the note the editor's document lacks (`firstStructuralDifference` in `core`, `whatIsLost` in the editor), and the banner names it and its line — the line of the body, which is what raw mode shows, frontmatter being stripped before either editor sees it.
  **It names what it found, whatever it found (2026-10-04).**
  A type it has no word for is named as it is (`markdown of the kind tableRow`), and text is shown with what cannot be seen written as its code point (`U+200B`).
  Where the note lacks nothing but the editor's document holds more — the difference is all addition — the check answers with the first node added, the text it holds, and the line of what it was added to, and the banner says the editor *would add* it.
  That case used to be described by the node it was added to, or by the note as a whole, and the banner then fell back to "markdown the rich editor has no way to show": a Google Drive note holding nothing but a picture was refused on an Android phone with that wording, and nothing on screen said what had been found.
  Only the note as a whole, which no single node explains, keeps the general wording.
  **And the lock lifts on the user's say-so, never by itself.**
  Once the body is not the one that failed — typed into, or replaced by a pull — the rich tab is offered again; pressing it (or `Mod+E`) settles autosave, reads the stored body back, and mounts the rich editor only once that body is the one on screen, so the check runs on what the user just wrote rather than the version before it.
  The mount check then runs as it always does, before anything can be typed, and a note that still fails is back in raw mode with nothing written.
  Typing never lifts it: the editor must not change under the user mid-sentence.
  Reference-style links are the one construct known to fail today — Milkdown writes them back inlined and drops the definition.
  Nothing in the corpus fails it today.
- A body arriving at a mounted editor is loaded only when it is genuinely new and did not come from that editor.
  Autosave is debounced, so the note's stored body is always a little behind what is on screen; reloading the editor from it — when the save echoes back, or on any re-render that happens to carry the same stale prop — silently deletes everything typed since.
  This is the rule with the sharpest teeth in the editor layer and it has its own tests.

**Fidelity test suite** (`packages/core/tests/markdown/roundtrip.test.ts`): a corpus of markdown fixtures — CommonMark spec samples, GFM tables/task lists, nested lists, code fences with languages, hard breaks, HTML blocks, files from Obsidian/iA Writer/Bear exports.
For each: `serialize(parse(md))` must equal `md` after both sides pass through the same normalizer, and `parse(serialize(parse(md)))` must be structurally identical to `parse(md)`.
And none of it may depend on how the file's lines end: the parser folds them first, so a note written on Windows is the same note.
It did not, and the carriage return remark left inside a soft line break made every CRLF note fail the fidelity check in §7 and open with the banner saying the rich editor could not show it.
Because Milkdown uses remark, `core`'s `pipeline.ts` wrap the same remark plugins the editor is configured with, so this suite exercises the editor's actual pipeline headless in CI.
A second layer (`apps/web/tests/richFidelity.test.ts`) mounts the app's own rich editor in jsdom — `createRichEditor`, with every schema change and node view it adds (2026-10-03) — and round-trips the same corpus through it.

Title is derived from frontmatter `title`, else the first top-level heading with any text in it — of any level, and either kind (`# Title`, or a line underlined with `===` or `---`) — else the filename.
The heading is found by parsing the body only to the end of the first line that may be one (`firstHeadingText` in `markdown/title.ts`, 2026-10-08, #275): a heading that ends on that line or before it does not depend on any line after it, so a heading found there is the first in the whole body.
The whole body is parsed, as it always was, where that heading holds a `[` (a reference is a link only if it is defined, maybe further down, and its text differs), where nothing is found there, and where that line ends past half the body, so a note costs at most half as much again as it did.
A heading with a `[` in it — a wiki link, `# [Draft] …` — is no quicker to find.
A test checks the answer against a parse of the whole body over four thousand bodies put together at random.

---

## 8. PWA specifics
- `vite-plugin-pwa` in `generateSW` mode to start (switch to `injectManifest` only if a custom worker becomes necessary): precache app shell (the answer to a navigation to the app's own route, and no other; below), `NetworkOnly` for `/api/*` (never a cached answer: binding follows what `/api/connection` says, see Phase 2), `NetworkOnly` for provider API origins, `registerType: 'prompt'` with an in-app "update available" toast.
- Manifest generated by the plugin: standalone display, icons, and a `share_target` that feeds the clipboard (below, "Shared to the app").
- Dev: enable `devOptions.enabled` so the SW runs under `vite dev`; `wrangler dev` serves the API on `:8787` and Vite `server.proxy` forwards `/api` to it so cookies stay same-origin.
  Prod is genuinely same-origin (SPA served as Worker static assets).
- All note data lives in IndexedDB; the app boots and renders from local state before any network call.
- **The fill window's page (2026-10-16, §7, "Filling in on a site").**
  `fill.html` is a second page of the build beside `index.html` (`build.rolldownOptions.input`), whose entry, `src/fill/main.tsx`, loads nothing of the app's sync, router or editors, nor the app's own entry; `tests/fillImports.test.ts` walks what it imports, dynamic imports too, to hold that.
  It opens the app's database as the app does, so a window from another build gives way to a newer one as a tab does (`StaleTabGate`).
  It is precached as every page is (`**/*.html`), and the precache answers `/fill` with it (Workbox's `cleanURLs`) before the navigation route, whose allowlist leaves it out, as it must: answered with the shell, the bookmarklet would open the whole app.
  Cloudflare serves `/fill` from `fill.html` by its default `html_handling`.
  Nothing is passed to it in a query string, which would miss the precache, or at all: what it knows of the page comes by `postMessage`.
  Before the app's service worker holds it — the first use in a browser, before the app has been opened there — `/fill` comes from the network (below, §9).
- **Keeping the store (2026-09-24, issue #132).**
  A browser treats an origin's storage as a cache until the origin asks otherwise: Chromium and Firefox may evict all of an unpersisted origin's storage at once under disk pressure, and Safari's tracking prevention deletes all script-writable storage, IndexedDB included, after seven days of Safari use with no user interaction with the site.
  For a device with nothing connected that store is the only copy, and the loss is silent — from inside the origin an evicted store and a new device look the same, so eviction is not detected, only guarded against.
  The app asks with `navigator.storage.persist()` (`store/keeping.ts`) at two moments.
  The first is the first note created in the device's own library, once per device (`storage.keepAsked` in `prefs`, written before the request so a prompt closed unanswered still counts), since Firefox answers with a permission prompt and a prompt must follow something the user did, never a page load.
  The second is `appinstalled`, whatever the earlier answer and without spending the first-note request, since being installed is one of the signals Chromium's silent heuristic weighs (https://web.dev/articles/persistent-storage).
  A failure anywhere in asking — the pref unreadable on a full disk, the API throwing — counts as not kept.
  `persisted()` never prompts, and the storage panel asks it on sight and again whenever the tab comes back into view: while the device's own library holds anything and the answer is no (or the browser has no API, which counts as no), the panel says the browser may clear the notes without warning and names what helps — connect storage, or download them (§7, "Getting a library out").
  Once kept, it says nothing.
  **Installing is not in that advice**, though issue #132 proposed it: it holds only in Chromium, where the installed app shares the tab's storage.
  Firefox on a desktop has nothing to install, and Safari keeps a Home Screen web app's data isolated from Safari's, so installing there opens an empty app and leaves the notes under the seven-day rule where they were.
  **Safari caveat:** a Home Screen web app's own domain is exempt from the seven-day cap.
  Whether a granted `persist()` also lifts it in the browser is not settled by WebKit's own words: the storage-policy post says an origin "might be excluded from eviction" when its storage is in persistent mode, and counts the seven-day deletion as eviction, without saying outright that one answers the other (https://webkit.org/tracking-prevention/, https://webkit.org/blog/14403/updates-to-storage-policy/).
  A second copy — connected storage or a download — is the advice that holds in every browser.
  `navigator.storage` is reached only through an injected `StorageKeeper`, since jsdom has none.
- **Files beside notes, on demand (2026-10-03, #187).**
  A file's bytes are never fetched by a pull (§7).
  They are read the first time the file is shown, through `syncScheduler.readFile` (`sync/fileReads.ts`), which answers from `fileBytes` where this device holds the file as it is now, and otherwise downloads it through the session the scheduler is running for the source in front of the user: its adapter, its token, and one retry after a refused token.
  A source it is not running (detached, held by a cancel, or not the one shown) answers `unavailable` for anything it does not hold, and so does one whose fresh token is refused too.
  A file nothing can be read for (pending, with no bytes here and nothing to copy) is `gone` wherever it is asked from.
  No Web Lock, since a read changes nothing on the remote and a picture should not wait behind a push.
  At most two downloads at once, so a note of forty pictures does not crowd out the sync, and one per file however many views ask for it — keyed by what is read as well as by the file, so a caller who asks after the row was bound to another file, or a newer version, is never handed the old one's bytes.
  A stalled download is ended by the adapter's own deadline, sized to the file (`timedFetch`, #190), which frees its slot.
  A caller that stops waiting is answered `aborted` without waiting for the download, and a queued download nobody is waiting for any more never starts.
  A file the remote does not have answers `gone` and never deletes the row: what the remote has is a pull's to say.
  A copy not uploaded yet, whose bytes this device never had, is shown from the bytes held of the file it copies (`copyOf`) where they are here, and otherwise read from that file, for showing only.
  What was downloaded is shown even when the store will not keep it.
  `readFile` never rejects.
  - **The cache budget.**
    What is downloaded is kept unpinned, under the version it was read at, in a cache of **250 MB** (`CACHE_BUDGET_BYTES` in `store/fileCache.ts`): ten of the largest file the app takes, or a few hundred photos.
    After each download the cache is trimmed least recently used first (`evictCache`), by the `[pinned+lastUsedAt]` index, counting sizes from the file rows so the count reads keys and never bytes.
    Three kinds of bytes are never let go of, and are not counted: pinned bytes, which are the only copy until they are up; a detached source's, which has no credential left to download them again; and those of a source resumed and not yet checked, which may hold what its remote lost (§7, "Files across sources").
    Nothing read from those last two is kept either: bytes held for a bound file there count as unsent work (`Unsynced.unverified`), and a picture merely looked at would be counted with them.
    Bytes with no row left are let go of whatever the budget and whichever the source, since nothing can show, export or move them.
    Reading held bytes is a read transaction, so pictures shown together do not queue behind each other.
    A use is written back at most once an hour (`TOUCH_AFTER_MS`), in a write of its own and never for pinned bytes: IndexedDB has no partial update, so each touch rewrites the whole value, bytes and all.
    The budget is fixed rather than read from `navigator.storage.estimate()`, which reports a quota the browser may not honour; the browser may still clear the whole origin, which is the previous item's subject.
  - **The copies' budget (2026-10-08, #276).**
    Smaller copies of pictures (§7, "Pictures, as this device has read them") have a budget of their own, **96 MiB** (`PICTURE_BUDGET_BYTES` in `store/pictures.ts`), apart from the originals'.
    That way a phone that lets a 25 MB photo go keeps the copy of a few hundred KB it was being shown from.
    After a copy is kept, if the copies come to more than the budget — counted from the small records alone, without holding up the library's files — `evictPictures` first lets go of everything stale (whose row has gone or moved on to other bytes), then copies, least recently used first, and never the copy just kept.
    The newest thumbs, up to three quarters of the budget (`THUMB_SHARE`), go after the copies a note is shown from, since a wall of cards needs all its thumbs at once; past that share the oldest go as any copy does, or a device with thousands of cards would keep no copy of a note's pictures but the last one made.
    A record whose copies have all gone is kept for its header, which costs a few bytes and keeps the picture's box the right size.
    A use is written back at most once an hour, as for an original, but to the small record, never the bytes.
  - **Object URLs.**
    The editor shows a file through a `blob:` URL, which holds its bytes in memory until it is revoked.
    `lib/objectUrls.ts` keeps one per key however many views show it, and revokes it five seconds after the last view lets go.
    One cache serves every note and every scratch card.
    The delay is there because the rich editor rebuilds its node views when it adopts a body, and a URL revoked between the old view and the new one is a picture that flickers.
    A rebuilt view takes the URL back without reading the bytes again (`reuse`).
    The key is the caller's, and has to name the bytes as well as the file: a version that moves on is a new URL.
- **The screen kept on through a long sync (2026-10-05).**
  A phone whose screen times out mid-import suspends the network, and the run fails part-way; what it had read is kept (§7, "A pull keeps what it has read"), but nothing moves until the phone is unlocked.
  While a run long enough to count is under way (`isLongRun` in `sync/progress.ts`, the panel's own threshold of 20) and the page is visible, `sync/wakeLock.ts` holds a screen wake lock (https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API), lets go of it when the run ends or fails, and asks again when the page is shown, since the browser lets go of it as the page is hidden.
  A refusal — battery saver — is taken as the answer until the page is shown again or another run starts.
  A browser without the API syncs as before.
  Pressing the power button still stops the run; the next one picks up from what was kept.
- **Shared to the app (2026-10-06).**
  The manifest's `share_target` makes the installed app a destination in the system's share sheet where the platform offers one: Android and ChromeOS. iOS and desktop Chrome on macOS and Windows do not.
  It is a `multipart/form-data` POST to `/share` carrying `title`, `text`, `url` and `files`, and never a GET, which would put what was shared in a URL that logs keep.
  - **The service worker answers it** (`receiveShare` in `apps/web/pwa.ts`, a `runtimeCaching` route for a same-origin `POST /share`).
    It keeps the words, joined a line each, and each file in Cache Storage (`skysa-share`, `/share/<id>` and `/share/<id>/<n>`, the listing written last), and answers `303` to `/?share=<id>`.
    A file over 25 MB is listed by name and not kept.
    Workbox writes the handler into `sw.js` from its own source (`toString()`), so it imports nothing and calls no helper of the module's.
    `tests/share.test.ts` runs it in a context holding only a worker's globals and reads what it kept with the page's half (`src/share/received.ts`), so the two cannot drift.
  - **The page always asks** (`share/TakeShare.tsx`), and then takes `share` out of the URL: "Add to the clipboard?", naming what came, for the source showing.
    Where that source's clipboard is hidden, the answer is "Show clipboard and add".
    The device's own notes and a disconnected source have no clipboard, and the user is told so.
    Whatever the answer, the kept share is deleted.
    §9 says why it asks even with the clipboard shown.
  - **With no worker, it reaches nothing.**
    The share sheet offers only an installed app, whose worker answers.
    If the worker were somehow missing, the POST would go to Cloudflare.
    That is the deviation from "no note content reaches the server" the owner accepted on 2026-10-06.
    The assets layer answers it `405 Method Not Allowed` without reading the body: with `run_worker_first` set, a path that is not an asset gets the single-page fallback's intent, and a non-`GET`/`HEAD` with an intent is refused there (`packages/workers-shared/asset-worker/src/handler.ts` in cloudflare/workers-sdk).
    `apps/api` is never invoked; `wrangler dev` logs `POST /share 405` from the assets layer.
    The bytes still cross the network to Cloudflare's edge, and that is the whole of it.
- **Installing from the browser (2026-10-06).**
  While the app runs in a browser tab (`display-mode: browser`), a banner under the top bar offers to install it (`install/InstallBanner.tsx`).
  It sits under the bar rather than over it because a compact window's search hangs from the bar to the foot of the window.
  - **Chromium** (desktop and Android) says it can install with `beforeinstallprompt`.
    That event can come before the banner mounts, so `main.tsx` imports `install/installPrompt.ts`, which listens from the start, prevents Chromium's own bubble and holds the event.
    The banner's Install button calls its `prompt()`, which may be called once.
    A declined prompt hides the banner until Chromium offers again; nothing is stored.
  - **Safari** has no event, so the banner names the menu item.
    On an iPhone or iPad: Share, then Add to Home Screen.
    Every iOS browser has it from 16.4, and iPadOS, which reports a Mac, is told apart by its touch points.
    On a Mac from Safari 17: File › Add to Dock.
    This is read from the user agent (`installHow.ts`), because nothing else says.
  - **Firefox on a desktop** cannot install web apps, so the banner says nothing there. https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
  - **It goes** once the app is installed, opened as installed, or moved into a window, which Chromium does as it installs.
    **Dismissed, it goes for good on that device**: `prefs.installDismissed` in IndexedDB, and never shown before that has been read, so a dismissed banner does not flash on load.
    There is no account to remember it across devices (§6), so each browser asks once.
  - The name it uses is the brand's, through `import.meta.env.VITE_APP_NAME` (`vite.config.ts`).
- Tokens: keep provider access tokens in memory (React state) with a copy in IndexedDB `syncState` so a reload doesn't force a backend round-trip.
  Never in localStorage.
- Installability is a checklist the browser applies silently — a missing 192px icon or a bad `start_url` and the install option simply never appears, with nothing in the build to say why.
  The manifest and Workbox options live in `apps/web/pwa.ts` rather than inline in `vite.config.ts` so that checklist can be a test (`tests/pwa.test.ts`), down to reading each icon's real dimensions out of its PNG header.
- With `registerType: 'prompt'` the worker does not claim the first page load, by design: the page that registered it keeps running the build it was served, and the next navigation is the first one the worker controls.
  So "works offline" means from the second visit onwards, which is the only thing it could mean — the first visit is the one that downloads the app.
- **Reload stops the app's requests first (2026-10-13).**
  The prompt's Reload asks the waiting worker to take over (`skipWaiting`), and the page reloads once it has.
  Chromium lets it take over only once the worker it replaces has no event in flight, and every request a page it controls makes is a fetch event there, a sync's to the provider most of all.
  A request that starts while the take-over waits holds it, and after that a quiet moment no longer lets it through: it waits out Chromium's five-minute limit on an outgoing worker, through Reload pressed again and the page reloaded by hand, with the prompt still up.
  Measured on Chromium 153 with two builds of the app and a page making four requests at a time: asked while they went on, the take-over came 300 s later, not when they stopped; asked once they had stopped, at once; a request already out when it was asked did no harm.
  A sync goes on most of the time the app is open, so Reload looked dead.
  Leaving provider and `/api/*` requests unrouted in the worker (no `NetworkOnly`) did not help: a request the worker does not answer is still a fetch event.
  So Reload pauses this tab's sync, as the user's pause does, and asks every other tab to pause too over a `BroadcastChannel` (`skysa-update`).
  It gives them 250 ms, then asks (`apps/web/src/sync/beforeUpdate.ts`).
  With a second tab making requests until told, the take-over and both reloads came in about 1.5 s.
  A pause lasts only until the app is opened again, so syncing starts again after the reload by itself.
  The prompt says it is updating meanwhile, and after ten seconds, what else will do it.
  A request nothing here makes, such as a picture opened at that moment or a tab still on a build from before this, still holds the take-over to the five minutes.
  The update *to* this build is one of those: the old page handles the click.
- **The shell answers only the app's own route (2026-09-29, issue #143).**
  The navigation fallback answered every path outside `/api/*` with the shell.
  So a page someone else serves on the same origin, most likely the operator's page a gate's action links to (§6, "Refusal codes and the connect gate"), opened as the app's "Not found" in any browser that had run the app once, while a browser that never had got the page.
  The fallback now has an allowlist, `/` with or without a search, because the app has one route and what it opens is in the hash, which no request carries, and the query (§7, "Where the user is, in the URL").
  Every other path goes to the network, and offline it gets the browser's own error rather than the app's "Not found".
  `tests/pwa.test.ts` checks every route the router has against the allowlist, so a route added under `src/routes` cannot be left out of it.
  A worker already installed keeps the old rule until its update is accepted (`registerType: 'prompt'`, above).

- **Brand (2026-10-01).**
  What the app is called and how it looks is a build input, `NOTES_BRAND`: the path to a `brand.json` that names the app (`name`, and a `shortName` of at most 12 characters for under a home-screen icon), describes it, gives the brand colour, the text on it and the title-bar colour for each of the light and dark themes plus the splash background, points at a folder of the six icons, and optionally gives woff2 files for a sans and a mono family.
  Without it the build uses `apps/web/brand/brand.json`: "Notes", in gray (`#4B5563` light, `#9CA3AF` dark), the curled-page icons on that gray, and the system fonts, so the default build carries no deployment's name, colour or mark.
  `apps/web/brand.ts` reads and checks it and stops the build on anything wrong — a missing field, a colour that is not `#RRGGBB`, a long `shortName`, an icon missing or at the wrong size (read from its PNG header, as `tests/pwa.test.ts` always did), a font file missing or not woff2 — since a build that went ahead would only install without an icon, or not offer to install, and say nothing.
  The installed app's navigation bar on Android is one colour for both themes, since a manifest has one value and no dark variant (Chrome's dark fields are an experiment it no longer reads), and which colour it is depends on the phone.
  On Android 14 and older Chrome paints it with `theme_color`, which is the light theme's `brand` (2026-10-11).
  From Android 15 an app cannot paint the bar: it is transparent over the app's window, which Chrome fills with `background_color`, the brand's `background`, the splash's colour.
  That was measured on a Pixel on Android 17 (2026-10-11): `theme_color` in the installed app and nowhere on screen, the bar exactly `background_color`, the page laid out between the system bars with no inset to fill.
  So neither leaving out `theme_color` (2026-10-10) nor setting it to the brand fixed a pale bar under the app in dark mode; the brand's `background` decides it, and `self-hosting.md` says so to whoever picks it.
  A deployment that gives `background` the light `brand`'s value has one bar on every phone.
  The page's `theme-color` tags still colour the status bar once it is open.
  It is read at build time and not served by `/api/config` because everything it covers is settled before the app could ask: the manifest and the iOS home-screen title and icon are read by the platform at install, the precache is revisioned when the app is built, and the first paint comes from IndexedDB with no network.
  A Vite plugin in `brand.ts` writes the title, the description, a `theme-color` per theme and the icon links into the page, with no script (§9); writes a stylesheet of `@font-face` rules and the custom properties `styles/` reads (`--brand`, `--on-brand`, `--font-sans`, `--font-mono`, the colours again under `prefers-color-scheme: dark`) as a file on this origin, so the Content-Security-Policy needs nothing new; and writes the icons at their fixed names and the stylesheet and fonts under `/brand/`, named by their content, beside the app, where the precache glob takes them in.
  `pwa.ts` builds the manifest from it.
  **The brand is never data identity.**
  The app folder's name, its marker file and the app name the marker validates, the IndexedDB name, and the lock and cookie names stay as they are whatever the brand says: renaming any of them would leave every library already connected unfound.
  A deployment's brand is the second thing it may bring besides the `createApp` seams and `ENABLED_PROVIDERS`, and it reaches the build the same way they reach the Worker, from outside the repo.

---

## 9. Security checklist
- PKCE + `state` on every OAuth flow; `state` bound to the browser that started it by the signed `__Host-skysa_flow` cookie, which also carries the device's credential hash (§6, "Per-connection credentials").
  `/start` is a same-origin POST, so neither the hash nor `state` can be planted by a link.
- The callback's answer (`__Host-skysa_flow_answer`) is signed like the flow cookie, and only a path in this app is ever taken from it, so it cannot be made into an open redirect.
  It holds no verifier, and a callback answered from it exchanges nothing (§6, "Storage OAuth, as built").
- `POST /api/connect-code` tells whoever asks whether a code is live, so it is same-origin and goes through the rate limiter before the policy is asked, and the code is never logged (§6, "Connect codes").
- `SECRETS_KEY` only in server env; secrets table encrypted at rest.
  A device's credential is never stored at all — only its SHA-256.
- Authorization is a per-connection bearer, never a cookie, so nothing is sent ambiently and CSRF stops being a class of bug here.
  The cost is that IndexedDB has no `httpOnly`: a stolen credential works until the device is revoked.
  `script-src 'self'` is therefore a hard requirement rather than a good default, HSTS is set on the shell, `GET /api/connection/grants` makes a theft visible, `DELETE` makes it revocable, and a grant unused for 180 days expires on the next read.
  Revoking nulls the grant rather than deleting it, so the hash stays spent: a deleted row would free its hash for whoever holds the credential behind it — the thief being revoked — to claim against storage of their own (§6).
- HSTS on the static shell: `max-age=63072000`, with neither `includeSubDomains` nor `preload` — each is a commitment for whoever self-hosts (from an apex domain the first takes in every subdomain they own, for two years), and theirs to make; `docs/self-hosting.md` says how.
  The credentials are origin-bound in IndexedDB and the flow cookie is `__Host-`, so subdomains were adding little.
  Held by `tests/csp.test.ts`.
- A rate-limit seam (`createApp({ rateLimiter })`, no-op by default) on the two connect routes and `/api/token`, which are the endpoints that spend an outbound provider call per attempt.
- The change relay, where it is turned on (§6, "Change relay"), carries no content and no path.
  Its ticket rides in a URL, so it is sealed, opaque and good for 30 seconds, and is never the credential or anything derived from it.
  The upgrade is same-origin and re-tests the grant; sockets close on revocation and after an hour; nothing per message is logged.
  The server does learn when each connection is edited, which the self-hosting guide says before an operator turns it on.
- *(Only if WebDAV is built, §5.4.)*
  WebDAV proxy: allowlist methods, reject paths that escape the configured base URL after normalization, strip hop-by-hop headers, 30s timeout, 20 MB body cap.
- *(Only if WebDAV is built, §5.4.)*
  WebDAV proxy SSRF hardening (on by default; protects operators who expose their instance to the internet): HTTPS only; resolve the host and reject private/loopback/link-local/cloud-metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, fc00::/7, ::1); reject IP-literal hosts; re-validate on redirect (or disable redirects); per-user rate limit and daily byte budget.
  Self-hosters could relax the private-range rule for a LAN Nextcloud.
  The `WEBDAV_ALLOW_PRIVATE` flag reserved for that does nothing today and is deprecated (§6, provider enablement); a built WebDAV would bring its own.
- CSP: `connect-src` limited to self + `www.googleapis.com` + `*.dropboxapi.com` + OneDrive's `graph.microsoft.com` and its download hosts (`*.files.1drv.com`, `my.microsoftpersonalcontent.com`, `*.sharepoint.com`, §5.2) — each provider's hosts added with its adapter, never ahead of it (WebDAV goes through the proxy, so it adds none).
  Set for every static response in `apps/web/public/_headers` (Cloudflare applies it to the shell, the assets and `sw.js`, and a response the service worker replays keeps it; `/api/*` is the Worker's and is not a page); `tests/csp.test.ts` holds it, including that every host the adapters request is allowed.
  `script-src 'self'` with nothing inline or eval'd: zod's `new Function` probe is turned off (`src/jitless.ts`, imported first), since it reports a violation even when refused.
  `style-src` allows `'unsafe-inline'` because the editors set style attributes and CodeMirror inserts `<style>` elements; `img-src` allows any `https:` image a note links; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.
- **A file beside a note is opened in this origin only as a type that runs nothing** (2026-10-03, #187).
  A `blob:` URL is the app's origin, so a file opened as HTML, XML or SVG would run whatever it holds as the app, with the storage credential within reach: exactly the XSS the `sk1_` trade-off in CLAUDE.md depends on never happening.
  So what opens in a tab is an allowlist (`safeOpenType` and `opensInTab` in `packages/core/src/files/attachments.ts`): pictures, PDF, audio and video, each shown in a viewer of the browser's own.
  Everything else is saved, never shown.
  A picture is drawn only through `<img>`, and an SVG only from a `data:` URL, whose origin is opaque.
  Tests pin the list, extension by extension and type by type; anything added to it must be a type that runs nothing.
  The types are read from the one table of what the app knows of each extension (`packages/core/src/files/mediaTypes.ts`, #449), but which extensions open is named one by one in `files/attachments.ts`, not read from a flag on that table, so that a row changed for an upload or a kind cannot widen it.
- **The clipboard runs nothing it is handed** (2026-10-06, §7).
  An item is drawn as text, as a picture through `<img>` from a `blob:` URL of raster bytes (never an SVG, which is a file card), or as a card that saves the file and never opens it.
  Of what the browser's clipboard holds, Paste reads plain text and pictures only, and never parses HTML.
  What another device put in the folder is no more trusted than what it put beside a note.
- **A picture's smaller copy is drawn by the browser, never by code of ours** (2026-10-08, #276).
  Copies are made in a module worker of the app's own (`apps/web/src/pictures/shrink.worker.ts`), started from its URL as `worker-src 'self'` allows — never from a `blob:` URL, and with no WebAssembly.
  The worker hands the picture to the browser's own decoder (`createImageBitmap`) and draws the result on a canvas off the page; nothing in it reads a picture's bytes, so a crafted file meets only the decoder `<img>` would.
  What it writes is a raster the canvas encodes (WebP, else PNG or JPEG), never a format that runs anything.
  The original is never altered, and a copy never goes into the user's folder.
- **A share is asked about, never taken** (2026-10-06, §8, "Shared to the app").
  The service worker cannot tell the share sheet's POST to `/share` from a form another site submits there.
  The `Sec-Fetch-*` headers are added after the worker, and a referrer can be left out.
  Taken without a word, any page the user visited could put what it liked on a clipboard every one of their devices shows.
  So the page names what came and adds nothing until the user says so, and a share it is not asked to keep is deleted.
  The id in `?share=` is taken only as a UUID, so a URL cannot point the page at any other key in the cache.
- **The bookmarklet's `javascript:` link is shown in the shell and never run there** (2026-10-16, §7, "Filling in on a site").
  Fill on sites draws it, by hand, to be dragged to the bookmarks bar or copied; a press on it is stopped, and the shell's `script-src 'self'` refuses `javascript:` addresses in any case, so nothing is added to it and no inline script enters the shell.
- **A link opens only to the web, an e-mail address or a phone number, and gets no hold on the app** (2026-10-12, §7, "Links open in the browser").
  What a note's link may open is an allowlist of schemes (`openableLink` in `apps/web/src/editor/features/links/links.ts`), asked of what the browser's own URL parser reads, so `java\tscript:` is the `javascript:` a browser would see.
  `javascript:` would run as the app with the storage credential in reach; `data:`, `blob:` and `file:` would show something as, or beside, the app.
  It opens in a new window with `rel="noopener noreferrer"`: the page opened has no `window.opener` with which to send the app's window somewhere else, and is not told which app it came from.
  A test pins the list.
- **A secret's words are on a device only in memory, and its key is in the folder only as a public one** (2026-10-14, §7, "Secrets in a note").
  The words are encrypted before they reach the editor's document, so no store, draft, held save, undo state, export or provider ever has them.
  The panel that shows them is outside the document.
  A device keeps its key in IndexedDB only wrapped under its unlock, and never in the folder, where a short unlock could be tried offline by anyone who can read it.
  What encrypts is age, held to age's own test vectors rather than to a format of ours.
  While a device is unlocked, a script running as the app can read the key and any words revealed: `script-src 'self'` carries this as it carries the `sk1_` credential, and locking when the page is hidden and after 30 s idle bounds how long there is anything to read.
- **A password is on a device only in memory, as a secret's words are** (2026-10-15, §7, "Passwords in the vault").
  Its username, password and notes are encrypted as they are typed, before anything is stored, so no store, held save, export or provider ever has them, and the form lets go of them as it closes and as the tab locks.
  Its label is plain, by the owner's choice, and is all that search indexes of it (of a body this version cannot read as an item, only what is plain in the file); an item whose body is more than its one fence is not written over, so nothing another app put beside it is lost.
  Copy puts a field on the system clipboard and nowhere else.
  A new password's characters are picked by `crypto.getRandomValues` with rejection sampling, so none is likelier than another.
  No site's icon is fetched for an item, since fetching it would tell a third party the item's label.
- **A site is told only its own logins** (2026-10-16, §7, "Filling in on a site").
  The fill window takes the page it fills to be the origin the browser stamped on the bookmarklet's `hello`, never anything the page says, and takes a `hello` only from its opener, from a page on the web that is not the app, and only the first; it sends a login to that origin alone, written as the browser wrote it.
  A page cannot make the browser stamp another origin, so a page, or a script on it, can be given only that page's own logins, which it could read as they are typed anyway.
  The bookmarklet hears only the window it opened, at the app's origin, and sends what the fields hold to the app's origin alone.
  The fill window depends on two of the app's headers staying as they are: `frame-ancestors 'none'`, so it is never drawn inside another site's page, where it could be dressed up, and **no `Cross-Origin-Opener-Policy`** on `/fill`, which would cut it off from the page that opened it (`tests/csp.test.ts` holds both).
  A site can still send the window it opened somewhere else (an opener may navigate what it opened), to a page dressed up as the window: the unlock that page could ask for opens nothing on another device, since a device's keys are wrapped under its unlock in its own IndexedDB, and the fill window never asks for the recovery key, which it leaves to the app.
  `/fill`, loaded from the network rather than the service worker, is asked for with the site's origin as its `Referer`, which the operator's edge can log; once the worker holds it, as it does from the app's first visit, it is not asked for at all.
  The window asks for the device's unlock only once it has taken a `hello`, so a page cannot set off the device's lock by opening `/fill` itself, and reads the login it sends from the item as it is when chosen, checked again against the page.
- **A file dropped where nothing takes it is refused** (2026-10-03, #187).
  The browser's default for a dropped file is to open it in place of the page, which unloads the app and whatever an editor had not saved yet.
  `useFileDropGuard` refuses such a drop at the window, with `dropEffect = 'none'`, wherever no handler has taken it and the target is not editable content.
  CodeMirror takes a drop without saying so, as an editable element does by default.
  - Editable by the nearest `contenteditable`: any value but `false`.
    A bar inside the rich editor (`contenteditable="false"`, whose events ProseMirror leaves alone) is refused like anywhere else, and so is a form field.
  - A drag aimed at a text node, which Firefox can do, is judged by the element the text is in.
- Disconnect revokes at the provider (Google `revoke`, Dropbox `auth/token/revoke`; Graph has no per-app revoke, so the disconnect confirmation links to where the user removes it: `LEFT_AT_PROVIDER` in `apps/web/src/sync/account.ts`).
  Google's revoke reaches every grant the user gave the Cloud project, which is why each deployment wants a project of its own (`docs/google-oauth.md`).
  Disconnecting does not yet tell the user when a revoke that should have worked failed (`revoked: false` from Dropbox or Google) — issue #124.

---

## 10. Build record

The record of how the product was built, phase by phase, is now [`history.md`](history.md).
A citation of "Phase N" means the heading of that name there, or "§10 Phase N" the same.
Phase 9, the sign-in layer, was never built: "Cleaning up after account-first" there says what became of it.

### Disconnecting without an invisible pile (2026-09-19)

A source that is let go must not leave notes where nobody can see them, and must not take unsent work with it unasked.
The decision record is [`decisions/0001-disconnecting-without-an-invisible-pile.md`](decisions/0001-disconnecting-without-an-invisible-pile.md).

---

## 11. Repo layout

```
pnpm-workspace.yaml
package.json                  # root scripts: dev, build, test, lint, db:migrate
apps/
  web/                        # Vite + React SPA
    vite.config.ts            # vite-plugin-pwa, the brand, /api proxy
    brand.ts                  # NOTES_BRAND: load and check a brand, write it into the build (§8)
    brand/                    # the default brand: brand.json, its schema, the six icons, recolour.mjs
    pwa.ts                    # manifest (from the brand) and Workbox options
    fill.html                 # the fill window's page, which the bookmarklet opens (§7, §8)
    src/
      main.tsx jitless.ts routes/
      components/             # by feature: account/, sources/, sidebar/, list/, note/, secrets/, passwords/, scratchpad/, clipboard/, attachments/, shell/; ui/ for the building blocks they share
      fill/                   # the fill window: its entry, the protocol, the bookmarklet (§7, "Filling in on a site")
      editor/                 # the two editors, over one markdown string (§7)
        shared/               # what both use: dirty, editorBinding, useAutosave. Imports neither rich/ nor raw/
        rich/                 # RichEditor (Milkdown): commands, format, markRun, markdown, actions/
        raw/                  # RawEditor (CodeMirror)
        toolbar/              # FormatToolbar, InlineToolbar
        features/             # find/, links/, secrets/, attachments/, code/: each feature's rich and raw halves side by side
      commands/               # the palette's and the chords' registry: registry.ts, chord.ts, context.tsx
      lib/                    # the bottom layer: plain browser helpers that import nothing else here
      hooks/                  # useLatest
      errors/                 # reached.ts: how far a failure got, for the messages that have to say
      install/                # installing from the browser (§8, "Installing from the browser")
      share/                  # what the system's share sheet hands the app (§8, "Shared to the app")
      pictures/               # smaller copies of pictures, made in a worker (§7, "Large libraries")
      secrets/                # the unlock, the key and the device's lock, over core's secrets/ and age/ (§7, "Secrets in a note")
      styles/                 # index.css imports the rest: tokens.css, base.css, primitives.css, then one per area (§7)
      assets/                 # what the build bundles: the providers' marks
      store/                  # Dexie db, notes.ts, folders.ts, and a module per thing the device holds: vault, clipboard, scratchpad, pins, pictures
      sync/                   # store.ts (SyncStore over Dexie), scheduler.ts (triggers, visibility, online events) — wraps core engine
      api/                    # typed client for apps/api
      i18n/                   # the app's words: t(), rich(), and the English catalog in en/ (§7)
  api/                        # Hono on Cloudflare Workers
    wrangler.toml             # D1 binding, [assets] → ../web/dist
    src/
      app.ts                  # createApp(options) — library export, no env access
      worker.ts               # default Worker entry: createApp with self-host defaults from env
      env.ts                  # parseEnv, envWarnings: the environment checked at boot
      routes/
        connect.ts            # /auth/connect/:provider/* (storage), /connect-code
        connections.ts        # /connection, /connection/grants[/:id]
        token.ts              # /token
        relay.ts              # /connection/relay/ticket, /relay (the change relay)
      relay/                  # the relay's hub seam, Durable Object, rooms and tickets
      db/                     # drizzle schema, client, migrations; connections.ts: the race-sensitive writes (commitConnection, revokeGrant, recordRefresh)
      context.ts              # AppEnv (a request's bindings and db), AuthedEnv (+ bearer), RouteDeps (what createApp hands every router)
      credentials.ts          # per-connection credentials: hash, bearer parsing, grant lookup
      flowCookies.ts          # the signed OAuth flow cookies (there are no sessions)
      crypto.ts               # AES-GCM helpers
      json.ts                 # parseJson (JSON checked by a zod schema) and formatIssues
      http.ts                 # fail(), tooMany, requireSameOrigin, jsonBody
      gate.ts                 # the connect gate and code check an EntitlementProvider offers
      device.ts               # deviceLabel: a grant's device, named from the User-Agent
      log.ts                  # logFailure: an error's name and first line, nothing more
      oauth/                  # storage OAuth: gdrive.ts onedrive.ts dropbox.ts pkce.ts common.ts
packages/
  core/                       # zero framework deps; runs in browser, Node, and Workers
    src/
      index.ts                # what the apps may use, by name; tests/exports.test.ts lists the values (#449)
      config.ts               # APP_FOLDER_NAME, MARKER_FILE
      cell.ts                 # cell(): the one way to hold a value that changes, where `let` is not allowed (#457)
      marker.ts paths.ts      # the marker file; paths as POSIX, relative to the app's root
      hash.ts json.ts         # content hashes; JSON from outside, checked
      api.ts relay.ts         # the shapes the app and the Worker both speak: refusals, the relay's frames
      entitlements.ts         # the seam an operator restricts minting through (§6, "Entitlement seam")
      scratchpad.ts           # the colours a scratch note can have
      appFolder.ts            # the app folder's places that are not notebooks: isScratchPath isVaultPath isClipPath isEncryptionFile
      files/                  # files that are not notes: mediaTypes.ts (one table of types) attachments.ts (how one is shown or opened)
                              #   pictures.ts (a picture's header, and the copies made of it) clipboard.ts (the clipboard's items)
      vault/                  # vault.ts (a password item's JSON and body) password.ts (the generator) sites.ts (which logins a page is offered)
      providers/
        types.ts              # StorageProvider interface, errors
        onedrive.ts dropbox.ts fake.ts
        text.ts               # a file's bytes as a note's text, or UnreadableError
        gdrive/               # Google Drive, by part: wire.ts (endpoints, answers, the client) root.ts (the app folder)
                              #   upload.ts cursor.ts (changes) duplicates.ts (two items at one path) index.ts
        idTree.ts             # the id → parent tree an id-based change feed is read against (OneDrive, Drive)
        http.ts               # what the HTTP adapters share on the wire: the transport, error bodies, Retry-After
        adapter.ts            # and on the contract's side: the marker, read as text, the root's guard, isSelf
      names/                  # what a file is called, below both providers and sync (#449): fold.ts (one name as every provider compares it)
                              #   bytes.ts (the 255-byte cap, cut at a character) slug.ts (a title, tag or folder as a name; a free name)
                              #   extension.ts (a name's extension) conflicts.ts (a conflict copy's name and path)
      sync/
        engine.ts conflicts.ts
        context.ts            # what every part of the engine is handed (EngineContext): provider, store, clock, ids, bounds, meter
        names.ts              # finding a free conflict name: tried in turn, bounded, the last refusal thrown (findFreeName)
        providerOps.ts        # asking the provider where "nothing there" is an answer: orIfNotFound, withParent
        outcome.ts            # what a run comes to (SyncOutcome) and the pieces every outcome is built from
        progress.ts           # how far the run under way has got, for onProgress: a scan's, a round's and a push's count
        pull/                 # the pull's pure parts, out of engine.ts (#446): batch.ts (what a batch's decisions are reached against) files.ts (the files' replay)
                              #   replay.ts (where a note, a folder, an unreadable file is once the decisions so far are applied)
                              #   occupancy.ts (which notes end up in or under a folder, and the names a copy there must not take)
                              #   attachments.ts (the files that are not notes, as a pull decides them: placed, adopted, gone, clashing)
                              #   cascade.ts (what a folder's deletion takes with it, and the folders above a kept note it must not)
                              #   folders.ts (the folders, as a pull decides them: made, moved, moved over, deleted once rescued)
                              #   deletions.ts (a deletion believed or not by the rest of the batch, and what it takes with it)
                              #   notes.ts (the notes, as a pull decides them: matched, read, reconciled, moved aside, let go of)
                              #   decided.ts (what a batch's decisions have already spoken for: written back, or said anything about)
                              #   reconcile.ts (a scan's last word on what it never mentioned)
                              #   decide.ts (a batch decided entry by entry, each sent to the part for its kind)
                              #   run.ts (a pull run: a round from the cursor or a scan from the top, a cursor reset, one auth retry)
        push/                 # the push's parts, out of engine.ts (#446): folders.ts (folders made before a write, and removed or left once empty)
                              #   files.ts (files that are not notes: uploaded, moved, deleted, beside what they meet)
                              #   notes.ts (notes: written after a rename, renamed or moved aside, deleted)
                              #   conflicts.ts (a write the remote would not take: set aside under a conflict name, or reconciled)
                              #   drain.ts (the queue drained in order, op by op, writes sent together, a failed op answered; createPush wires the parts)
      markdown/
        frontmatter/          # split.ts (the block found and taken off the body) read.ts (the fields the app understands)
                              #   write.ts (fields written back, nothing else touched, or refused up front); each builds on the one before (#449)
        attachments.ts
        pipeline.ts           # remark pipeline (same plugins/options as the editor) + normalizer, used by editor and tests
        lineEndings.ts        # the three spellings CommonMark calls one, folded on read and chosen on write
        preview.ts            # a body as the lines a list can show; the one rule the note preview and the search excerpt share
        secretBlocks.ts       # a secret's `age` fence: found, labelled, kept out of the search index, rewritten; no curve
      age/                    # the age format: header, stream, armor, keys, over @noble's primitives (§7, "Secrets in a note")
      secrets/                # recoveryKey.ts (the printed key, typed back) encryptionFile.ts (.encryption.json; its path is appFolder.ts's)
                              #   sealing.ts (sealing and opening a secret: the one module here with the curve in it)
    tests/
      testing.ts              # @skysa/core/testing: the fake, the provider stubs, the store contract, for the apps' tests
      providers/contract.test.ts
      markdown/roundtrip.test.ts
      sync/*.test.ts
```

Dependency rule: `core` imports nothing from `apps/*`.
`web` and `api` may import `core`, by its main entry, `@skysa/core`, which names what it offers rather than re-exporting whole modules (#449); their tests may also import `@skysa/core/testing`, and their source may not, nor any path into a `tests` folder (ESLint).

Inside `apps/web/src` the layers point one way too (2026-10-22, ESLint's `no-restricted-imports`): `lib/` is the bottom, plain browser helpers that import nothing of the app; `store/` is the data layer and imports neither the sync layer, the UI nor the editors; `sync/` imports the store, `api/`, `errors/` and `i18n/`, and no UI; `editor/` does not import `routes/` or `sync/`.
Inside `core`, nothing under `providers/` imports `sync/` (#449): what both need, a conflict copy's name say, sits below them in `names/`, which imports neither of them nor `markdown/`.
Neither `core` nor the Worker may import a Node built-in, and the list is Node's own (`module.builtinModules`), not a hand-kept one.

A `.ts` and a `.tsx` may not share a stem in the same directory.
TypeScript resolves the `.ts` and the `.tsx` is silently left out of the program: `tsc` is happy, the tests still run under Vite, and only ESLint complains — with "was not found by the project service", which names the symptom and not the cause.
It happened to `tests/commands.test.tsx` beside the existing `tests/commands.test.ts`, and the shadowed file had a real lint error in it that nothing had been reporting.
Rename one of them.

Source files are text.
A control byte other than tab, newline or carriage return — a NUL written as itself rather than as `\u0000`, say — makes git call the file binary, and from then on it is absent from every diff, every blame and every three-way merge, while prettier, ESLint and `tsc` all pass it without a word.
It has happened twice here, once to the largest new file in a PR, which went through three rounds of review without a reviewer ever seeing it.
Write the escape.
`apps/web/tests/noControlBytes.test.ts` walks `apps`, `packages`, `docs`, `.github` and the root files, and fails with the path, the byte and what to do about it.
It lives under `web` because it needs `node:fs`, which `core` may not have even in a test.
Two details are load-bearing, both learned the hard way in review: it walks rather than asking `git ls-files`, because git run inside a tree that some *outer* repository ignores reports no files at all and a guard with nothing to iterate passes silently — so it also carries a canary, and a walk that does not find the test itself fails.
Git is asked only to *narrow* the walk, and only when its answer names that same file, which is what keeps a `.DS_Store` or a scratch file nobody committed out of the results without ever letting git's silence stand for "clean".

---

## 12. Resolved decisions (formerly open questions)

1. **App folder name:** `skysa-notes`, exported as `APP_FOLDER_NAME` from `packages/core/src/config.ts`.
   It governs the folder Google Drive and WebDAV create.
   OneDrive and Dropbox derive their app-folder name from the provider registration, so those registrations must be named to match; Dropbox's name is immutable after creation, so if the constant changes before launch, re-create the Dropbox app.
2. **Remote folder renames apply even when contained notes are dirty.**
   Metadata-only; see §7.
3. **Several connected sources on one device since Phase 7**, each its own silo, one shown at a time.
   There is no user to hold them: nothing on the server knows that two connections belong to one person (§6).
4. **Hosting: Cloudflare Workers** for API + static SPA, D1 for the database.
   See §6.
5. **Cold start is a full scan.**
   No remote index file.
   Revisit if cold start exceeds ~10 s at ~2k notes.
6. **Every note the app creates lives in a notebook; the root is not one.**
   The sidebar lists notebooks, and opens the one the URL names, else the one open last on this device, else the first (2026-10-01; §10 Phase 7).
   A notebook with nothing in it, nor in any notebook inside it, begins a note when it opens, as `+` does, and a note begun is stored only once something is written in it — a name given, or a keystroke in its text — so one opened and left blank is no file in the user's folder.
   The root is the container notebooks live in, not a place to put notes, so the app will not create a note there — and it gets a row only in the case below.

   **Resolved (Phase 2).**
   A `.md` file sitting loose at the root of the remote app folder — put there by hand, or by another tool — imports to a note in no notebook, which the sidebar had no way to show.
   We do **not** move those files: relocating them would contradict "the user sees the same structure from any other tool" (§1) and quietly rewrite their remote layout.
   Instead the sidebar grows a **"Loose notes" row that appears only when the root actually contains notes**, below the notebooks, showing the count.
   It is not the "All notes" row removed in Phase 1: that one always showed and misdescribed what it held; this one names exactly what it holds and disappears when empty.
   Opening it lists those notes and leaves "New note" disabled, because the app still does not create notes at the root.

   Three consequences worth knowing about:
   - `ROOT` is `''`, and an empty hash is indistinguishable from none, so the URL spells the root `/` and a notebook `/work/` (§7, "Where the user is, in the URL").
     The spelling lives in `apps/web/src/routes/place.ts` and nothing else in the app knows about it.
   - A notebook created while the loose notes are open goes beside them, at the root — the root is not a notebook and cannot be a parent.
   - The tree and the count of loose notes come from two independent live queries.
     Neither `undefined` may be read as "there are none", or the app opens one folder and jumps to another a frame later — with no notebooks at all it would briefly tell a user whose whole library is loose notes that they have nothing.
     `selectedFolderPath` takes the count, not a boolean, for exactly this reason.

## 13. Distribution and licensing

### Repo
One public repo, `skysa-notes`, containing everything in §11.
It is self-hostable and complete: placeholders only in `wrangler.toml`, `.dev.vars.example` listing every key, no operator credentials or deployment-specific configuration in the tree.
Defaults are `AlwaysAllowedEntitlementProvider`, `AUTH_MODE=storage-first`, and `ENABLED_PROVIDERS` defaulting to what an operator can run without registering several apps (`dropbox`).
Anyone who needs different behavior composes it through `createApp` (§6) rather than forking.

### License: AGPL-3.0 + CLA (decided; confirm final CLA text with a lawyer)
- **AGPL-3.0** for all code — version 3 **only** (SPDX `AGPL-3.0-only`).
  `NOTICE` carries the grant and says version 3, the four `package.json` files say `AGPL-3.0-only`, and both CLAs promise version 3; they said "or later" until 2026-09-18, which this document never did, and a licence field that disagrees with the notice is two answers to one question.
  A later version can still be adopted deliberately — the CLA's relicensing grant allows it — which is the point of not granting it in advance.
  Anyone may use it, including commercially, but anyone offering a modified version as a network service must publish their modifications, so improvements made to deployed instances flow back.
  Standard posture for self-hostable web apps (Plausible, Cal.com, Ghost).
- **CLA**: Apache ICLA adapted (entity name substituted, "Project" for "Foundation"), structured as a **license grant, not an assignment**, so contributors keep ownership and it remains valid in jurisdictions that don't allow copyright assignment.
  Two clauses borrowed from the Harmony agreements: (1) Skysa promises every contribution will remain available under AGPL-3.0, and (2) contributors retain full rights to use their own contributions elsewhere.
  The grant includes the right to sublicense and relicense, which keeps future licensing options open.
  Individual CLA required from day one; an adapted Apache CCLA (entity CLA) is prepared but only requested the first time someone contributes on behalf of an employer.
  Enforced by `contributor-assistant/github-action` blocking merges from unsigned contributors.
- Rejected: PolyForm Noncommercial (not open source; would block "open source" framing) and BUSL (change-date complexity without much benefit over AGPL).

Also:
- `TRADEMARK.md`: the code license does not grant use of the `skysa-notes` / Skysa name or logo; forks must rebrand.
- The providers' marks in `apps/web/src/assets/providers/` are Dropbox's, Microsoft's and Google's trademarks, shipped unaltered to say which service a source is — the use each one's brand rules allow — and are not under AGPL-3.0 (`TRADEMARK.md`, "Other companies' marks").
- Third-party license audit before publishing (Milkdown, CodeMirror, Hono, Drizzle, Workbox are all MIT/Apache — fine; re-check any additions).
  - **Shipped code** is inside the MIT/Apache/ISC set `CLAUDE.md` requires, with one election to record.
    **dompurify** reaches the tree transitively through Milkdown under `MPL-2.0 OR Apache-2.0`; we **elect Apache-2.0**, which is one-way compatible with AGPL-3.0.
    Two facts about it, both checked rather than assumed: it is not vendored or patched, so MPL-2.0's file-level copyleft would attach to nothing; and as of this writing it is not in the built bundle at all — `@milkdown/crepe` and `@milkdown/components`, the only things that reach it, are tree-shaken out of `apps/web/dist`.
    **Switching `RichEditor` to `@milkdown/crepe` would start shipping it**, at which point the Apache-2.0 election is the thing that makes that fine.
    Re-check if it is ever vendored or patched.
  - **Build- and test-time dependencies are not all in that set**, and the audit above is about what ships, not about what a contributor installs.
    Present exceptions, none of which reaches the bundle: `@img/sharp-libvips-*` (**LGPL-3.0-or-later**, via sharp ← miniflare ← wrangler), `lightningcss` and `lightningcss-*` (**MPL-2.0**, via Vite), `axe-core` (**MPL-2.0**, via `eslint-plugin-jsx-a11y`), `caniuse-lite` (**CC-BY-4.0**, via browserslist).
    Each is used unmodified as a tool, which is what those licenses are written for.
    Re-run this scan before publishing rather than trusting the list — it is a snapshot, not a rule.

### Self-hosting model
A self-hoster needs: a Cloudflare account (Workers Free is sufficient indefinitely for personal use; the daily limits are unreachable by one person), their own Google/Entra/Dropbox app registrations (named `skysa-notes` so folder names match), and ~15 minutes with `docs/self-hosting.md`.
Their Google app is in "Testing" (at most 100 test users, refresh tokens expiring after 7 days) until they publish it.
With only non-sensitive scopes, publishing needs no verification; brand verification is optional and only shows their name and logo (`docs/google-oauth.md`).
Every storage provider needs its own app registration; WebDAV, which would not, is deferred (§5.4).

Operators running an instance for many users should know two things, both to be documented in `docs/self-hosting.md`:
- Workers Free hard-stops at 100k requests/day until 00:00 UTC, which would break token refresh for every user of the instance at once.
  Workers Paid bills per request instead, lifts the CPU limit (set `limits.cpu_ms = 50` in `wrangler.toml` to cap runaway cost), extends logs to 7 days, and enables Logpush.
  Capacity is not the concern: Free covers roughly 5k daily actives at ~20 Worker requests/user/day, and static assets are free and unlimited on both plans.
  Pricing verified 2026-09.
- Back up D1 with `wrangler d1 export` on a cron trigger.
  The database holds encrypted refresh tokens and connection metadata, never note content.

## 14. Not planned (possible future add-ons)

None of these are in any phase.
Listed so the reasoning isn't lost if they come up.

- **WebDAV.**
  Deferred indefinitely (2026-09-17).
  The design is in §5.4, and what building it would take is recorded in issue #122, not scheduled.
- **Share target.**
  Moved out of Phase 7 (2026-09-18).
  The share target is a manifest entry and a route that turns a shared URL or selection into a note.
  Not hard, and not what the app is for.
  *Import was on this line until 2026-10-05* (§7, "Getting a library in").
  The reason given was that the export is the tree a provider folder holds, so dropping its files into the app folder is the import; under Google Drive's `drive.file` scope it is not (§5.1), since the app never sees files it did not make, and a user who did exactly that found an empty library.
  *Export came off it on 2026-09-24* (issue #133, §7 "Getting a library out"), because on a device with nothing connected the store is the only copy.
- **Other encodings.**
  A file that is not UTF-8 is left alone rather than converted (§7).
  Reading Latin-1 or UTF-16 means guessing, and writing it back means either changing the file's encoding under the tool that made it or keeping an encoding per note.
  The fix is a "save as UTF-8" away, in the tool that wrote the file, and the storage panel says which files need it.
- **Sign-in separate from storage.**
  Was Phase 9; dropped 2026-09-18 (§6).
  Identity and data are coupled deliberately, so this is not "later" — it is decided against.
  What it would have taken, kept so the cost is not re-discovered: an `identities` table and `IdentityProvider` adapters for Google and Microsoft; merge-by-verified-email, whose hard part is that the *existing* user's email must be verified too, since a storage-first user is created with whatever the storage provider called the account and a Microsoft `email` claim is set by a tenant's admin — matching on the incoming provider alone lets a crafted tenant sign in as someone else; explicit in-session linking (`?link=1`) for Hide-My-Email relays and differing addresses; a second Google Cloud project, because Google revokes every grant to a project at once and disconnecting storage would otherwise sign the user out of their sign-in; and a reconciliation between two authorization paths, since a user would own connections that already have credentials of their own.
  The three add-ons that hung off it went with it: **Apple sign-in** (a `.p8` JWT client secret rotated every six months, `form_post` callback, name delivered only on first authorization, relay addresses), **Facebook sign-in** (email not guaranteed, so an email-confirmation step, plus Meta App Review and possible Business Verification), and **magic link** (an `email` identity type, transactional email with SPF/DKIM/DMARC, and a one-time-code fallback for the PWA's link-opens-in-another-browser problem).

## 15. GitHub setup

Organization **`skysa-org`** — `skysa` was taken.
Created before the first commit; it is the named party in the CLA and `TRADEMARK.md`, where the *project* is called "Skysa" rather than the org handle, since the handle is an availability accident and the legal entity behind the name is still unsettled (Phase 8 flags it for the legal review).
Org-level: required 2FA, secret scanning with push protection.

| Repo | Visibility | Contents | Deploys? |
|---|---|---|---|
| `skysa-org/skysa-notes` | Public, AGPL-3.0 | The workspace in §11. Placeholders only in `wrangler.toml`; `.dev.vars.example` | No. CI + dry-run only |
