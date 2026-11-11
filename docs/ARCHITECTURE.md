# skysa-notes — Architecture and decisions

Local-first markdown note-taking PWA that syncs to a dedicated, app-owned folder on the user's cloud storage (Google Drive, OneDrive, Dropbox).
WebDAV was planned too and is deferred indefinitely (§5.4).
Notes are plain `.md` files in a normal directory tree, so the user can open, edit, and back them up with any other tool.

This repo is the complete, self-hostable product: one Cloudflare Worker serving the SPA and a small API, plus the operator's own provider app registrations.
This document is the source of truth for the architecture, and with the records in [`decisions/`](decisions/README.md), for every decision behind it.
Update it when a decision changes.
It is not a to-do list: open work lives in GitHub issues.
The record of how the product was built is [`history.md`](history.md).

Every heading has an anchor that does not change with its number or its wording, such as `ARCHITECTURE.md#sync-loop-per-connection`, and a numbered one has its number as well (`#s7`, `#s5-1`).
Cite by anchor from now on; a citation such as `§7, "The scratchpad"` still works, and a test checks that each one leads somewhere.

---

<a id="core-decisions-settled"></a><a id="s1"></a>
## 1. Core decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Storage model | App creates and owns a dedicated root folder on each provider; never touches anything outside it | Keeps every provider on user-consent-only scopes; avoids Google restricted-scope (CASA) review |
| File format | One markdown file per note, folders = notebooks, optional YAML frontmatter | Human-readable, portable, diffable, editable by other tools |
| Identity | Notes identified locally by UUID; remote identity is provider file id (Drive/Graph/Dropbox) or path (WebDAV) | Ids survive renames on id-based providers; WebDAV has nothing else |
| Client | Vite + React + TypeScript SPA, `vite-plugin-pwa` (Workbox) for the service worker, TanStack Router, Dexie (IndexedDB) for local store | Local-first app gets nothing from SSR; vite-plugin-pwa is the best-maintained PWA tooling in the React ecosystem |
| Backend | Hono + TypeScript on Cloudflare Workers, D1 via Drizzle | Tiny, streams bodies natively (WebDAV proxy), Workers-native |
| Repo | pnpm workspace: `apps/web`, `apps/api`, `packages/core` (markdown, names, secrets — framework-agnostic), over the kit's packages for the providers, the sync engine and the server (record 0018) | Keeps the hard parts testable without any UI or server framework |
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

<a id="architecture-overview"></a><a id="s2"></a>
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

<a id="note-format-and-directory-layout"></a><a id="s3"></a>
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
The marker's name, its `app` and its version, with the folder's name and Drive's tag on it (§5.1), are `NOTES_FOLDER` in `config.ts`, which the app hands the adapters as an `AppFolderSpec` rather than their importing it ([record 0018](decisions/0018-the-shared-kit.md)).
A test pins each value: a library already connected is found by them.

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
  It is hidden (`isHidden`), but this app syncs it all the same, as it does `.vault/` (below): `syncsHidden` (`appFolder.ts`) lets a first segment that is exactly `.scratchpad` through, so the engine, which is handed it, and export and import, which ask `isPassedOver`, take its notes as notes.
  A dot name inside it (`.scratchpad/.DS_Store`) is still hidden, and so is `.clipboard/`.
  `isScratchPath` (`appFolder.ts`) says whether a path is in it.
  A scratch note may carry two keys a notebook's does not: `pinned: true` and `color: <name>`, one of `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple` and `pink` (`SCRATCH_COLORS`).
  Unpinned and no colour are written by taking the key away, and a colour the app does not know is read as none and left in the file.
  Both are taken away when a note leaves the folder for a notebook.
  Neither is part of what makes a block metadata, since a note's first line may be `Color: …`.
  In the scratchpad, where a note need not have a name, `untitled-2.md` is as unnamed as `untitled.md`; in a notebook it stays a name, as it always was.
  **A cursor read while the folder was hidden** (2026-10-08) had passed over every scratch note other devices had sent by then, and a feed names a file again only when it changes, so a device that updated after the notes were made never had them.
  Schema version 10 drops every source's cursor once, as "Re-scan" does (`rootId` kept), and the next sync is a scan, which reads nothing the device already holds at its version.
  Any later change to what `syncsHidden` lets through needs the same.
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
  `syncsHidden` lets it through as it does `.scratchpad/`, so the engine, export and import take its notes as notes — a download of the source has them, and importing that download brings them back as passwords, still encrypted to the key they were made with — and a dot name inside it is still hidden.
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
<a id="provider-adapter-interface"></a><a id="s4"></a>
## 4. Provider adapter interface
Every provider implements one interface, `StorageProvider`, and the sync engine talks to nothing else.
It is the kit's (`@skysa/storage`), with its errors and the contract suite every adapter passes ([kit §4](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#provider-adapter-interface)).
---

<a id="provider-specifics"></a><a id="s5"></a>
## 5. Provider specifics
The adapters are the kit's (`@skysa/storage`), and so is what each provider does that the others do not ([kit §5](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#provider-specifics)).
This app hands them its folder, with its marker and Drive's tag on it (`NOTES_FOLDER`, §3), and the format of its notes (`NOTE_FORMAT`, §7, "Conflict rule").

<a id="google-drive"></a><a id="s5-1"></a>
### 5.1 Google Drive

The kit's ([§5.1](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#google-drive)), with the scope `drive.file` and the root found by its tag, never by name.
- **A folder the app has left (2026-10-13).**
  The directory a notebook moved, renamed or deleted here leaves behind is not deleted on Drive, where `drive.file` hides from the app what the user put in it, but tagged as left (`notesappLeft`), and not reported while it holds nothing the app can see.
- **What the user adds through Drive is not the app's.**
  Under `drive.file` the app sees only the files it made, so the storage panel says so (`UNSEEN_AT_PROVIDER` in `apps/web/src/sync/account.ts`, 2026-10-05), from "About Google Drive" in its gear, and the way in for such notes is an import (§7, "Getting a library in").
- **The change feed lags (2026-10-06).**
  A new file takes seconds to reach Drive's change feed, and a listing can still name a file the feed has reported trashed.
  Both reached users through the change relay (§6), whose notice comes the moment a write is answered, so a device looks again after a notice (the scheduler's), and lists the clipboard, and reads the key file, twice (`lookTwice` in `sync/notesSync.ts`).

<a id="onedrive-microsoft-graph"></a><a id="s5-2"></a>
### 5.2 OneDrive (Microsoft Graph)

The kit's ([§5.2](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#onedrive-microsoft-graph)), in the app's special folder, `approot`.

<a id="dropbox"></a><a id="s5-3"></a>
### 5.3 Dropbox

The kit's ([§5.3](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#dropbox)), as an App-folder app.

<a id="webdav"></a><a id="s5-4"></a>
### 5.4 WebDAV
*Deferred indefinitely (2026-09-17).*
WebDAV is not being built, and the design as it was planned is the kit's ([§5.4](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#webdav)).
- The adapter takes a `fetch`-like function, so it can point at the proxy in the browser and at the server directly in tests; a Nextcloud container was the planned test target.

<a id="backend"></a><a id="s6"></a>
## 6. Backend

The backend is the kit's: `@skysa/server`, a Hono app on Cloudflare Workers, built as a library ([skysa-kit's §6, "Backend"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#backend)).
The design that was here is there: the composition root and its seams (entitlements, connect codes, rate limits, the relay), provider enablement, the storage OAuth flows, the server's half of the per-connection credential, the data model, the endpoints and the change relay.
This app's part is its deployment, in `apps/api`:
- `src/worker.ts` is the default Worker entry, and the only module here that reads the environment.
  It builds the config through the server's own `parseEnv`, logs what `envWarnings` says of it, hands it to `createApp` with the relay's Durable Object when `RELAY` is on, and answers with `misconfigured` while the config is wrong.
- `@skysa/api` and `@skysa/api/relay` (`src/index.ts`, `src/relay.ts`) are the server's names as this package has always offered them: the stock entry imports them, and so does a deployment's own, so an operator who needs different behavior still writes an entry rather than a fork (`docs/self-hosting.md`).
- `wrangler.toml` binds D1, whose migrations are the kit's (`migrations_dir = "node_modules/@skysa/server/migrations"`), and serves the SPA from the same Worker through `[assets]`, so `/api/*` and the app share an origin.

What the kit's section decides that this app is built around, each named here because this app's documents cite it by name:
- **Entitlement seam:** an operator restricts who may connect, and mint tokens, through an `EntitlementProvider` handed to `createApp`; the repository ships one that allows everyone ([kit §6](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#backend)).
- **Refusal codes and the connect gate (2026-09-24, issue #131).**
  A refusal carries a code from a fixed list, and the seam may offer a gate, a message and one link, which the app shows where the provider buttons are ([kit §6](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#backend)).
- **Connect codes (2026-09-28, issue #139).**
  The gate may ask for a code, which the policy checks as it is used and again at the callback, and may answer with a value the app holds in its place ([kit §6](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#backend)).
- **No sign-in separate from storage.**
  Decided 2026-09-18, and it closes what used to be two modes behind an `AUTH_MODE` env.
  Identity and data are coupled: a connection is reached by the credential the device that made it holds, and nothing anywhere aggregates connections under a subject.
  A person with Dropbox and Google Drive connected has two silos, and the server cannot tell they are one person — which is the property, not a limitation to be fixed later.

  What this closes, so it is not re-opened by accident: no `identities` table, no `IdentityProvider` adapters, no Google/Microsoft sign-in, no merge-by-verified-email, no account linking, no magic link, and no `arctic` dependency — whose deprecation (July 2026) had been an open question since 2026-09-14 and is now moot rather than decided.
  §14 keeps the reasoning and what it would have cost.

  The gain is that a whole class of question stops needing an answer here: which of two identities a grant belongs to, what a verified email is worth, what happens when a linked provider is unlinked, and who may see a connection someone else made.
  A shared instance is still possible — that is what the entitlement seam is for — it just gates on the storage account rather than on a user the server invented.

  **Still in the tree, and going:** `AUTH_MODE` (an env var with one legal value), the `users` and `identities` tables (the kit's `packages/server/src/db/schema.ts`, unread by any code), and the client's `account-first` branch in the storage panel (`components/account/NotConnected.tsx`).
  They are left standing in the change that made this decision because dropping the two tables is a hand-written D1 migration and this is a documentation change; issue #118 tracks them.

<a id="storage-oauth-as-built"></a>
### Storage OAuth, as built (Phase 2)

The kit's ([§6, "Storage OAuth, as built"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#storage-oauth-as-built)).
Disconnecting Google Drive revokes every grant the user gave the Cloud project at once, which is why `docs/google-oauth.md` asks for a project per deployment.

<a id="per-connection-credentials"></a>
### Per-connection credentials (Phase 7)

There is no shared user: a connection is reached by a credential the device that made it holds, `sk1_…`, which the server sees only as its SHA-256.
The server's half — the connect flow, the lookup by hash, grants and their cap, and the migrations behind them — is the kit's ([§6, "Per-connection credentials"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#per-connection-credentials)).

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
  *Revised 2026-10-05:* in a wide window's sidebar, where the panel is now one line and a gear (`history.md`, "The storage panel gave connection management up entirely"), the count is a device icon and a number in that line, beside the gear, and the rows open over everything from it.
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
*Partly revised 2026-10-02:* each grant now keeps a label for its device, "Safari on iPhone", worked out from the User-Agent of the app's own request to start connecting (the kit's `packages/server/src/device.ts`), carried to the callback in the signed flow cookie, and refreshed when the device reconnects.
*Revised the same day:* it was first taken from the callback, the browser's navigation back from the provider, and a Chrome on a Mac arrived there saying it was Safari on an iPhone; whatever rewrites a User-Agent for the provider's pages (an extension, a site setting) reaches the callback, and the start is the app asking.
It needs nothing that says who is asking — it is what the device is, not whose — and it is the label only: never the header, which says which build of which system, and no address or place.
A row that said only "a device, last used 9:48 AM" could not be told from the phone in the user's pocket, which is the one comparison the list exists for.
Names the user gives a device are still not done.
A grant from before `0006`, or from a browser the label does not know, has none and says "A device".
The device list plus `DELETE` is enough to act on a theft the user knows about; anything more would need something that can say *who* is asking, and after 2026-09-18 there is deliberately no such thing: the credential names a connection, not a person.
A revocation list is the one of the three that could still be built on what exists.

<a id="data-model-drizzle-d1"></a>
### Data model (Drizzle, D1)

The kit's ([§6, "Data model"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#data-model-drizzle-d1)), with its migrations.

<a id="endpoints"></a>
### Endpoints

The kit's ([§6, "Endpoints"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#endpoints)).

<a id="change-relay"></a>
### Change relay (optional, 2026-10-05)

The kit's ([§6, "Change relay"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#change-relay)).
It is off unless `RELAY = "true"`, and its Durable Object is declared in `wrangler.toml` either way.

<a id="local-store-and-sync-engine-client"></a><a id="s7"></a>
## 7. Local store and sync engine (client)

<a id="indexeddb-schema-dexie"></a>
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
A file that is not a note is a row of its own (`SyncFile` in `@skysa/sync`, the kit's `packages/sync/src/store.ts`), mirrored as what the remote says of it — path, id, version, size — and never its bytes, which are fetched when the file is shown and kept apart in `fileBytes`.
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

**Pushing files, and pulling them (2026-10-03, #187)**, are the engine's: three ops, `upload`, `move-file` and `delete-file`, an upload that holds up no note behind it, and a pull that mirrors the remote's files beside the notes and never reads one as a note ([the kit's "Files beside documents"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#files-beside-documents)).
The single-device soak (`randomRemote.test.ts`) and the two-device suite (`overProviders.test.ts`) are the kit's too.
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

<a id="sync-loop-per-connection"></a>
### Sync loop (per connection)
1. **Pull**: the engine's ([kit §7, "Sync loop"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#sync-loop-per-connection)).
   It reads from the stored cursor, or scans the whole folder on a new device, and applies what it reads a batch at a time, keeping the cursor only once its batch is in the store.
   A run says how far it has got (`onProgress`), and the storage panel shows the count from twenty notes up (`syncCount` in `components/account/statusWords.ts`), so an edit's sync does not flash a bar.
   - **A pull keeps what it has read until its batch commits (2026-10-05).**
     A pull that fails part-way, as one does on a phone whose screen goes off mid-import, starts again without reading again what it had read ([kit §7, "Sync loop"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#sync-loop-per-connection)).
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
2. **Push**: the engine's as well ([kit §7, "Sync loop"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#sync-loop-per-connection)).
   It drains `opQueue` in order, and sends the writes of notes at its front several at once where the provider takes them (four on Google Drive); a write the remote refuses goes through the conflict rule, a refused token is asked for again once, and an op that keeps failing is tried again with a wait between and then said.
3. **Triggers** are the kit's scheduler's (`@skysa/client`, [kit §7, "Sync loop"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#sync-loop-per-connection)): the app opening, the tab regaining focus, `online`, every minute while visible, shortly after a local edit, and where the deployment runs the change relay (§6) its notice, which is one more trigger and never a replacement for the others.
   **When a push goes** is the scheduler's too: an edit's ops go 2 s after the last one queued, and whatever is waiting goes at once as the page is hidden.
   This app queues nothing lazily, and passes the scheduler no `lazyMs`.

<a id="folder-renames-moves"></a>
### Folder renames/moves
A folder renamed or moved on the remote is applied here whatever is dirty in it, since a move does not conflict with an edit.
One renamed, moved or deleted here goes up as its notes' and files' moves or deletes, and then an `rmdir` for each directory they left, which removes a directory only while it is the one the queue meant and holds nothing ([kit §7, "Folder renames/moves"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#folder-renames-moves)).

<a id="re-arranging-is-moving"></a>
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

<a id="the-sidebar-opens-as-far-as-it-is-asked"></a>
### The sidebar opens as far as it is asked (2026-10-05)

A notebook with notebooks inside it lists them only while it is open, and a notebook starts shut: a library brought in from elsewhere can be hundreds of notebooks nested three deep, and listed whole the sidebar was a column to scroll to find anything in.
The decision record is [`decisions/0004-the-sidebar-opens-as-far-as-it-is-asked.md`](decisions/0004-the-sidebar-opens-as-far-as-it-is-asked.md).

<a id="pinned-to-the-top"></a>
### Pinned to the top (2026-10-05)

A notebook or a note can be pinned, from its `⋯` or a right-click on its row: "Pin to top", first in the menu, and "Unpin" once it is.
The decision record is [`decisions/0005-pinned-to-the-top.md`](decisions/0005-pinned-to-the-top.md).

<a id="a-notebook-lists-what-is-inside-it"></a>
### A notebook lists what is inside it (2026-10-07)

A notebook's list shows its own notes, then the notes of every notebook inside it, at any depth.
The decision record is [`decisions/0009-a-notebook-lists-what-is-inside-it.md`](decisions/0009-a-notebook-lists-what-is-inside-it.md).

<a id="where-the-user-is-in-the-url"></a>
### Where the user is, in the URL (2026-10-06)

The hash names the place the user is, a slug for each name, so the title says where they are and Back and Forward work.
The decision record is [`decisions/0007-where-the-user-is-in-the-url.md`](decisions/0007-where-the-user-is-in-the-url.md), and "A dropdown is a step on a phone" is in it.

<a id="conflict-rule-concrete"></a>
### Conflict rule (concrete)
Remote wins the original path.
Local content is saved as a new note at `<path minus .md> (conflict <YYYY-MM-DDTHH-mm>).md` with the same frontmatter except a fresh `id`.
Both appear in the UI; a small banner links to the pair.

The engine applies the rule, and the stamp is written as the kit's section says: UTC, to the minute, with `-2` and on for a second copy in the same minute, and the name not slugified, so the copy sorts beside its note ([kit §7, "Conflict rule"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#conflict-rule-concrete)).
This app hands the engine its document format, `NOTE_FORMAT` in `markdown/format.ts` ([record 0018](decisions/0018-the-shared-kit.md)): the kit makes the copy's name for the format's extension (`documentNames`), and the copy's contents, with a fresh `id`, are `packages/core/src/markdown/conflictCopy.ts`.

<a id="merge-before-the-copy"></a>
### Merge before the copy
An app may make the two sides one before the conflict rule applies, through the engine's `merge` option ([kit §7, "Merge before the copy"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#merge-before-the-copy)).
This app passes none, so for it the rule above is the whole of it.

<a id="edits-the-editor-has-not-saved-yet"></a>
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

<a id="what-the-loop-above-left-open-and-how-the-engine-answers-it"></a>
### What the loop above left open, and how the engine answers it
The cases the branch table does not mention are the kit's engine's, each decided in the direction that cannot lose an edit ([kit §7, "What the loop above left open"](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#what-the-loop-above-left-open-and-how-the-engine-answers-it)): moves and deletions read against the whole batch, one note per path, folders made, moved, left and removed, files that are not notes, stuck ops, rescans, and renames of notes holding edits.
Among them, the ones this app's documents cite by name:
- **The version a move hands back is not the note's until its bytes are known**, since another device may have edited the file since this one's pull.
- **A file that is not UTF-8 is left alone**: `read` refuses it, nothing is imported, and no row holds the id of a file the engine could not read.
- **A path can be reused**: the path is a fallback to `remoteId`, and never claims a note whose own file is alive elsewhere in the batch.
- **A rename need not re-list what is inside it**: a folder at its new path and its children's old paths deleted is read as the rename it is.
- **A round is one batch**: from a stored cursor every page is read before anything is decided, and the round is applied with its cursor.
- **A push conflict over a file another note already holds is not that note's conflict**: the note moves aside rather than adopting the file.
- **A directory the user's notebook left is removed by an op of its own, and only when five things agree.**
- **A folder is removed only where a listing can prove it empty**, which on Google Drive it cannot, so there the folder is left (§5.1, "A folder the app has left").
- **A dead `rmdir` is given up on rather than surfaced**, since nothing behind it depends on it.
- **A notebook the remote no longer has does not take the notes whose files were never in it.**
- **A rate limit is not an attempt**: a `RateLimitError` is retried without counting toward the five failures that stop an op.

What follows here is this app's own: search, the window and what is in it, and the commands.

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
**Ticking a task leaves the keyboard where it is (2026-11-02).**
A phone's keyboard can be put away while the editor keeps the focus, and then any tap raises it again, wherever the tap lands, and the browser scrolls to the cursor: on Chrome for Android, ticking a box brought both back.
Nothing in the editor asks for this, and it is the touch rather than the tick that does it, so while the editor has the focus the box refuses the touch at `touchstart` and ticks on `touchend`, if the finger stayed within 10px (`editor/rich/tasks.ts`).
Refusing `touchend` as well brings the keyboard back, measured on Chrome 133 in an emulated Pixel 9.
The cost is that a swipe begun on a box does not scroll while the editor has the focus; with the focus elsewhere there is no keyboard to raise, so the touch goes through, a swipe scrolls, and the mouse events after a tap do the ticking.
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

<a id="getting-a-library-out"></a>
### Getting a library out (2026-09-24)

"Download all notes" writes the source showing as one zip of markdown, from the palette (`app.download`) or the storage panel.
The decision record is [`decisions/0002-getting-a-library-out.md`](decisions/0002-getting-a-library-out.md).

<a id="getting-a-library-in"></a>
### Getting a library in (2026-10-05)

"Import notes" brings notes in from the user's disk, from the storage panel of the source showing (its gear, or the source's `⋯`).
The decision record is [`decisions/0006-getting-a-library-in.md`](decisions/0006-getting-a-library-in.md), and "Into the scratchpad" is in it.

<a id="the-clipboard"></a>
### The clipboard (2026-10-06)

A clipboard a source's devices share.
The decision record is [`decisions/0008-the-clipboard.md`](decisions/0008-the-clipboard.md).

<a id="the-scratchpad"></a>
### The scratchpad (2026-10-07)

Quick notes on a wall of cards.
The decision record is [`decisions/0010-the-scratchpad.md`](decisions/0010-the-scratchpad.md).

<a id="the-vault"></a>
### The vault (2026-10-15)

What the app calls the place a source keeps what only its devices can read.
The decision record is [`decisions/0014-the-vault.md`](decisions/0014-the-vault.md).

<a id="secrets-in-a-note"></a>
### Secrets in a note (2026-10-14)

Words the folder holds only encrypted.
The decision record is [`decisions/0013-secrets-in-a-note.md`](decisions/0013-secrets-in-a-note.md), and "Replacing the key", "The device's own lock, where there is one" and "Notes from another source" are in it.

<a id="passwords-in-the-vault"></a>
### Passwords in the vault (2026-10-15)

A password manager, kept where the secrets are.
The decision record is [`decisions/0015-passwords-in-the-vault.md`](decisions/0015-passwords-in-the-vault.md).

<a id="filling-in-on-a-site"></a>
### Filling in on a site (2026-10-16)

A bookmarklet fills a site's login from the passwords, and remembers one typed there.
The decision record is [`decisions/0017-filling-in-on-a-site.md`](decisions/0017-filling-in-on-a-site.md).

<a id="large-libraries"></a>
### Large libraries (2026-10-08, #275)

A long list draws only what is near the screen, so a phone can hold a notebook of a thousand notes.
The decision record is [`decisions/0012-large-libraries.md`](decisions/0012-large-libraries.md).

<a id="the-apps-words"></a>
### The app's words (2026-10-07)

Every word the app shows or reads out comes from one catalog, `apps/web/src/i18n/`, rather than being written where it is said, so that a translation is a second catalog and not a change to every component.
The decision record is [`decisions/0011-the-apps-words.md`](decisions/0011-the-apps-words.md).

<a id="dialogs"></a>
### Dialogs (2026-10-15)

Every dialog is built one way (`components/ui/Dialog.tsx`).
The decision record is [`decisions/0016-dialogs.md`](decisions/0016-dialogs.md).

<a id="editor"></a>
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

**A finished task sinks (2026-11-02).**
In a checklist one level deep, ticking an item moves it just below the last item still to do, at the top of the ones already done, so what is left to do stays together at the top and the latest done comes first; unticking it moves it back up, above the done ones directly over it (`editor/rich/tasks.ts`).
It rewrites the file's order, so it happens only on a tick, in the tick's own undo step, and never on opening a note: a list written somewhere else keeps its order until an item in it is ticked, and then only that item moves.
A list with items under items stays as it is, since a place under a parent says what the item is part of, and so does a list with plain items among its tasks.
A selection inside the item goes with it.
Since the next box then sits under the pointer, a press within 300ms of the last is ignored, and the box never toggles itself: a double press ticks one task, not two.

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

<a id="pwa-specifics"></a><a id="s8"></a>
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
  A phone whose screen times out mid-import suspends the network, so while a run long enough to count is under way and the page is visible, the kit's client holds a screen wake lock (`keepAwakeWhileSyncing`, [kit §8](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#pwa-specifics)).
  A refusal, such as battery saver's, is taken as the answer until the page is shown again, and a browser without the API syncs as before.
  Pressing the power button still stops the run; the next one picks up from what the last had read and kept (§7, "A pull keeps what it has read").
- **Shared to the app (2026-10-06).**
  The manifest's `share_target` makes the installed app a destination in the system's share sheet where the platform offers one: Android and ChromeOS. iOS and desktop Chrome on macOS and Windows do not.
  It is a `multipart/form-data` POST to `/share` carrying `title`, `text`, `url` and `files`, and never a GET, which would put what was shared in a URL that logs keep.
  - **The service worker answers it** (`receiveShare` in `apps/web/pwaApp.ts`, which `pwa.ts` makes a `runtimeCaching` route for a same-origin `POST /share`).
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
  What is this app's own is handed in (`PwaApp`, made in `pwaApp.ts`): the one route its shell answers, and its share target, checked in `tests/pwa.app.test.ts`.
- With `registerType: 'prompt'` the worker does not claim the first page load, by design: the page that registered it keeps running the build it was served, and the next navigation is the first one the worker controls.
  So "works offline" means from the second visit onwards, which is the only thing it could mean — the first visit is the one that downloads the app.
- **Reload stops the app's requests first (2026-10-13).**
  Chromium lets a waiting worker take over only once the one it replaces has no request in flight, and one that starts while the take-over waits holds it to a five-minute limit, so with a sync going Reload looked dead.
  So Reload pauses this tab's sync and asks every other tab to pause too, then asks the worker to take over: the kit's client's (`makeWay`, [kit §8](https://github.com/skysa-org/skysa-kit/blob/main/docs/ARCHITECTURE.md#pwa-specifics)).
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
  That default is the app's, handed to the build (`DEFAULT_BRAND` in `pwaApp.ts`), and the brand file's JSON Schema is the build's (`apps/web/brand.schema.json`).
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

<a id="security-checklist"></a><a id="s9"></a>
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
  The types are read from the one table of what the app knows of each extension (`@skysa/storage`'s `files/mediaTypes.ts`, #449), but which extensions open is named one by one in `files/attachments.ts`, not read from a flag on that table, so that a row changed for an upload or a kind cannot widen it.
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

<a id="build-record"></a><a id="s10"></a>
## 10. Build record

The record of how the product was built, phase by phase, is now [`history.md`](history.md).
A citation of "Phase N" means the heading of that name there, or "§10 Phase N" the same.
Phase 9, the sign-in layer, was never built: "Cleaning up after account-first" there says what became of it.

<a id="disconnecting-without-an-invisible-pile"></a>
### Disconnecting without an invisible pile (2026-09-19)

A source that is let go must not leave notes where nobody can see them, and must not take unsent work with it unasked.
The decision record is [`decisions/0001-disconnecting-without-an-invisible-pile.md`](decisions/0001-disconnecting-without-an-invisible-pile.md).

---

<a id="repo-layout"></a><a id="s11"></a>
## 11. Repo layout

```
pnpm-workspace.yaml
package.json                  # root scripts: dev, build, test, lint, verify (the gate before a push), db:migrate
docs/                         # this file; decisions/ (a record per decision); history.md (the build record)
.changeset/                   # a changeset per PR; README.md says how a release is cut
scripts/setup.sh              # first-run setup
apps/
  web/                        # Vite + React SPA
    vite.config.ts            # vite-plugin-pwa, the brand, /api proxy
    brand.ts                  # NOTES_BRAND: load and check a brand, write it into the build (§8)
    brand.schema.json         # a brand file's JSON Schema, for an editor
    brand/                    # the default brand: brand.json, the six icons, recolour.mjs
    pwa.ts                    # manifest (from the brand) and Workbox options
    pwaApp.ts                 # this app's route, share target and default brand, handed to the build
    public/_headers           # the CSP: nothing may be added to script-src (§9)
    scripts/                  # size.mjs: the size budget CI holds the build to, measured by bundleBudget.mjs
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
      pictures/               # smaller copies of pictures, made in a worker (§7, "Pictures, as this device has read them")
      secrets/                # the unlock, the key and the device's lock, over core's secrets/ and age/ (§7, "Secrets in a note")
      styles/                 # index.css imports the rest: tokens.css, base.css, primitives.css, then one per area (§7)
      assets/                 # what the build bundles: the providers' marks
      store/                  # Dexie db, notes.ts, folders.ts, and a module per thing the device holds: vault, clipboard, scratchpad, pins, pictures
      sync/                   # store.ts (SyncStore over Dexie), dexiePorts.ts (the kit's client's ports over Dexie), notesSync.ts (the kit's scheduler, with this app's companions)
      i18n/                   # the app's words: t(), rich(), and the English catalog in en/ (§7)
  api/                        # the Worker: this app's deployment of the kit's server (@skysa/server, §6)
    wrangler.toml             # D1 binding, with the kit's migrations; [assets] → ../web/dist
    src/
      worker.ts               # default Worker entry: createApp with self-host defaults from env
      index.ts relay.ts       # @skysa/api and @skysa/api/relay: what a deployment's own entry imports
packages/
  core/                       # this app's own, beside the kit's packages; zero framework deps, runs in browser, Node, and Workers
    src/
      index.ts                # what the apps may use, by name, and the kit's protocol for an operator's code; tests/exports.test.ts lists the values (#449)
      config.ts               # APP_FOLDER_NAME; NOTES_FOLDER, this app's folder as the kit's adapters are handed it
      scratchpad.ts           # the colours a scratch note can have
      appFolder.ts            # the app folder's places that are not notebooks: isScratchPath isVaultPath isClipPath isEncryptionFile
      files/                  # files that are not notes: attachments.ts (how one is shown or opened)
                              #   pictures.ts (a picture's header, and the copies made of it) clipboard.ts (the clipboard's items)
      vault/                  # vault.ts (a password item's JSON and body) password.ts (the generator) sites.ts (which logins a page is offered)
      names/                  # this app's names: slug.ts (a title, tag or folder as a name; a free name)
                              #   notes.ts (isNoteName, and a note's copy's name and path, from the kit's documentNames)
      markdown/
        format.ts             # NOTE_FORMAT: this app's documents, as the kit's engine and adapters are handed them (record 0018)
        conflictCopy.ts       # a conflict copy's contents: the local note's, with a fresh id
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
      folderSpec.test.ts      # NOTES_FOLDER, and the marker 1.0 wrote, byte for byte, against the kit's code
      markdown/roundtrip.test.ts
```

The kit's packages are dependencies, not paths here: the provider adapters and the sync engine are `@skysa/storage` and `@skysa/sync`, the shapes the app and the Worker both speak `@skysa/protocol`, the sync client — the scheduler, the API client and the credentials — `@skysa/client`, and the Worker `@skysa/server` (§6), each pinned to one exact version ([record 0018](decisions/0018-the-shared-kit.md)).

Dependency rule: `core` imports nothing from `apps/*`, and of the kit only `@skysa/protocol` and `@skysa/storage`.
`web` and `api` may import `core`, by its main entry, `@skysa/core`, which names what it offers rather than re-exporting whole modules (#449), and the kit's packages by theirs; their tests may also import a kit package's `/testing` entry, and their source may not, nor any path into a `tests` folder (ESLint).

Inside `apps/web/src` the layers point one way too (2026-10-22, ESLint's `no-restricted-imports`): `lib/` is the bottom, plain browser helpers that import nothing of the app; `store/` is the data layer and imports neither the sync layer, the UI nor the editors; `sync/` imports the store, `errors/` and `i18n/`, and no UI; `editor/` does not import `routes/` or `sync/`.
Inside `core`, `names/` sits below `markdown/` and imports nothing of it (#449).
The kit's engine and adapters import nothing of this app's: they are handed its `DocumentFormat` and its folder instead ([record 0018](decisions/0018-the-shared-kit.md)).
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

<a id="resolved-decisions-formerly-open-questions"></a><a id="s12"></a>
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

<a id="distribution-and-licensing"></a><a id="s13"></a>
## 13. Distribution and licensing

<a id="repo"></a>
### Repo
One public repo, `skysa-notes`, containing everything in §11.
It is self-hostable and complete: placeholders only in `wrangler.toml`, `.dev.vars.example` listing every key, no operator credentials or deployment-specific configuration in the tree.
Defaults are `AlwaysAllowedEntitlementProvider`, `AUTH_MODE=storage-first`, and `ENABLED_PROVIDERS` defaulting to what an operator can run without registering several apps (`dropbox`).
Anyone who needs different behavior composes it through `createApp` (§6) rather than forking.

<a id="license-agpl-3-0-cla-decided-confirm-final-cla-text-with-a-lawyer"></a>
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

<a id="self-hosting-model"></a>
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

<a id="the-shared-kit"></a>
### The shared kit (2026-11-09)

The layers here that do not care what a file holds are to move to a repository of their own, `skysa-org/skysa-kit`, which this app, skysa-draw and memoriam will depend on from npm.
They are the storage providers, the sync engine, the connect and credential server, the browser's sync client and the PWA build.
Every storage option, today's three and any added later, is built there and nowhere else.
Until this app depends on it, this repository is still the whole product, as above.
The first six seams are cut:
- the adapters are handed the app's folder (§3), and the scheduler its lock's name;
- the engine and the adapters are handed what a document is (`NOTE_FORMAT`);
- the engine and the scheduler take the app's merge where it has one, and this app has none (§7, "Merge before the copy");
- the engine is handed which hidden paths sync (`syncsHidden`) and which a pull is to say it met (`watch`, and `SyncOutcome.met`), and this app's are in `appFolder.ts`;
- the queue and the scheduler say when a push goes: an app may queue writes lazily and give the scheduler `lazyMs`, and this app does neither (§7, "When a push goes");
- the scheduler builds nothing of this app's own: the clipboard, the key file and the files beside notes are attached to it, with the watch they read (`sync/notesSync.ts`);
- the scheduler and the provider factory say nothing in words of their own, and the factory is handed what a timeout says (`timedOut`);
- the in-memory store and the store contract are handed the format, and make a conflict copy with it, while the Dexie store, which is notes', makes notes';
- the credential, the token source and the relay reach the database through ports (`CredentialTable`, `TokenStates`), made over the app's database in `sync/dexiePorts.ts`;
- the scheduler reaches it through one port (`ClientStore`, made by `clientStoreOf` in the same file), and a lint rule kept Dexie, the app's tables and its words out of everything that was to move, until it moved: the kit's client has no Dexie to import, nor the app's words.

Every fix in skysa-draw's and memoriam's copies of these layers was this app's already, and the tests they had that it lacked are here.
A lint rule, `kit/fence` over `KIT` in `eslint.config.js`, holds every module that moves, and every test that moves with it, to what goes with it.
Those tests run on a format and a folder of the kit's own (`TEST_FORMAT`, `TEST_FOLDER`), and this app's own are pinned by its own tests.
The client's tests that ran over this app's database follow as suites over a device (`ClientDevice`, now `@skysa/client/testing`), which the kit runs over ports in memory and this app over its database; the token source's and the relay's have, the scheduler's port has a contract run over both, and so have the scheduler's own tests, but for its companions', which are this app's.
The kit's repository is made, with these layers and their history, its own CI, CLA and documents, and its release wiring, and 0.1.0 is on npm (record 0018, step 2).
The decision record is [`decisions/0018-the-shared-kit.md`](decisions/0018-the-shared-kit.md).

<a id="not-planned-possible-future-add-ons"></a><a id="s14"></a>
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

<a id="github-setup"></a><a id="s15"></a>
## 15. GitHub setup

Organization **`skysa-org`** — `skysa` was taken.
Created before the first commit; it is the named party in the CLA and `TRADEMARK.md`, where the *project* is called "Skysa" rather than the org handle, since the handle is an availability accident and the legal entity behind the name is still unsettled (Phase 8 flags it for the legal review).
Org-level: required 2FA, secret scanning with push protection.

| Repo | Visibility | Contents | Deploys? |
|---|---|---|---|
| `skysa-org/skysa-notes` | Public, AGPL-3.0 | The workspace in §11. Placeholders only in `wrangler.toml`; `.dev.vars.example` | No. CI + dry-run only |
