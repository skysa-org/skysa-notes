# 0006. Getting a library in

*2026-10-05. Cited in the code as §7, "Getting a library in". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**"Import notes" brings notes in from the user's disk**, from the storage panel of the source showing (its gear, or the source's `⋯`).
It first asks for a folder or files, Choose folder or Choose files (2026-10-13, the owner's choice; until then they were two items, "Import a folder" and "Import files"), since no browser's picker takes both: `webkitdirectory` makes an input a picker of folders and nothing else.
Each button is a press, so the picker it opens is one the browser allows (`pickFiles`).
It reverses §14 for import.
That entry said import needed nothing of its own, because dropping files into the app folder is the import; on Google Drive it is not, since `drive.file` shows the app only the files it made (§5.1).
A user who emptied the folder on the Drive website and copied a folder of old notes in watched the deletions sync and then saw nothing.
Made by the app, the same files are its own and sync as any note does.
It also gives a device with nothing connected a way in at all.

**What is read.**
A folder (`<input webkitdirectory>`), from inside it: the folder picked is not a notebook, so its notebooks land at the top of the source.
Or files: each `.zip` unpacked, anything else at the top as it is.
An archive keeps its own tree, a wrapping folder included, so unpacking "Download all notes" into a source gives back the library it came from.
The ZIP is read by hand (`store/readZip.ts`), as it is written by hand: the central directory, stored and deflate entries (deflate through the browser's `DecompressionStream('deflate-raw')`, so no dependency and nothing for the CSP), names as UTF-8 where they read as UTF-8 and as `windows-1252` where they do not (APPNOTE's default is code page 437, which the browser cannot decode; the two agree on the letters a name is likely to hold).
Encrypted entries, other methods, damaged entries (a checksum or size that does not match) and anything declared over 25 MB are listed as unread, and the rest come in.
Inflation stops just past the declared size, and the compressed bytes go into the decompressor 16 KB at a time, each write awaited, because Chromium and WebKit inflate a whole written chunk before the reader is answered: one write of a 25 MB entry built to inflate to gigabytes took the tab down before the count saw a byte.
A folder entry is one whose name ends in `/` or `\`.
ZIP64 and spanned archives are refused whole.
A backslash in a name is a separator, as every reader takes it, and `normalizePath` keeps a name from climbing out of the root.

**What comes in** (`planImport`, `importLibrary` in `store/importLibrary.ts`) is what the folder would have brought had a provider shown it to the app.
Every `.md` (folded) is a note and every other file is a file beside the notes, each at its own path.
What stays out is said, in the question asked before anything is written:
- a note that is not UTF-8 text, as sync leaves one alone (§14, "Other encodings");
- a note the app keeps hidden, whose name or a folder's above it begins with a dot.
  A hidden file that is not a note (`.obsidian`, `.git`) is a tool's settings, and stays out without a word;
- a file over 25 MB, known from its size before it is read;
- a file the browser cannot read (gone since it was picked, or a cloud drive's placeholder), and an archive that cannot be read at all.

What stays out by its name is not read either, so a `.git` of a few hundred megabytes picked with a folder costs nothing.
A ZIP is unpacked when picked as a file; inside a picked folder it is a file like any other, as it would be had a provider shown the folder.
A pick that comes to more than 1 GB to read is refused before a byte of it is read, and one whose archives unpack past that is refused as they do: the tab holds all of it until the transaction is through.

What the system leaves in a folder (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `__MACOSX`) stays out without a word.
A name segment a provider would refuse is changed, and the question says which: each of `"*:<>?\|` and the C0 controls becomes `_`, trailing dots and spaces and leading spaces go, and a Windows device name gets `_` after its stem.
Drive takes any of these, but a source's notes can be moved into another account (§6), and a refused name is an upload that fails on every try in an ordered queue.
Nothing else about a name changes, since the notes' links name their files by exactly what they are called.

**How it lands**, in one transaction against the source as it is when it opens.
The digests are worked out, and every note read, before it opens ("Large libraries"); a note numbered there whose title may be its name's is read again in it.
It is the rules a bind copies a pile by (`moveRowsTo`), applied to files from disk:
- **Notebooks.**
  A notebook the source has, in any spelling, is the one things go into, under its spelling; a new one is a row and a `mkdir`.
  One whose name a file there has taken (a file with no extension) goes beside it under a conflict name, and everything picked under it follows: a `mkdir` where a file is fails on every try, and holds up the queue behind it.
- **Notes.**
  A note whose name is taken by a live note, or by an earlier note of the same import (`Plan.md` and `plan.md` from a case-sensitive disk), is numbered (`freePath`, asked only of the names in that one folder: asked of every path in a source of thousands, for each of thousands, it was the whole cost).
  Each note is the file it was, `source` and all, so the push sends exactly the bytes picked, line endings included, and the app adds its frontmatter only when the note is next edited (§3).
  It is dirty and owed a write, since the remote does not have it.
  Its id is its frontmatter's unless the source holds that id already (the same archive imported twice), when it takes a fresh one.
- **Files.**
  A file the source has at that name with that size is the same file and is not sent again.
  One of another size, or one whose name a notebook has, there already or made by the import, goes beside it under a conflict name that keeps its extension, as an upload does.
  Each new file is a pending row with its bytes pinned, owed an upload.
- **Order.**
  Notebook by notebook (`queueByNotebook` in `store/queue.ts`, by which `queueOwed` orders a bind too).
  The notes at the top come first, since they need no `mkdir`.
  Then each notebook, depth first, siblings by name — folded, so a notebook two rows spell two ways is one, and compared by `localeCompare`, as paths are sorted elsewhere: its `mkdir`, then the uploads of the files directly in it, then the writes of the notes directly in it, then the notebooks inside it in the same way.
  So a notebook is always made before anything in it.
  It was every `mkdir`, then every upload, then every write; with some forty notebooks and a thousand notes on Google Drive, where a note is about four requests one after another, another device showed every notebook, empty, long before the first note reached any of them.
  Now it fills in a notebook at a time.
  Files go before notes so that the pictures beside a note arrive ahead of it.
  One a note links from elsewhere — a notebook inside its own, such as the `assets/` some exporters write, or another notebook by `../` — can arrive after the note, which shows it as not there until it lands, as after an upload that failed.
  Only what the import queues is ordered so: an op already in the queue keeps its place, and a note, file or notebook with one queued is not queued again.

Refused (`ImportRefusedError`) for a detached source, for one whose first import is still filling it, and for one this device has no record of (disconnected since the question was asked); and into the device's own notes while a bind holds them, since a bind takes only what was written in the pile since by `updatedAt`, which an imported note takes from its file.
The panel offers it in none of these, nor while the disconnect question is open, as for the download.
Another source's row menu does not offer it: showing that source first spends the press, and a browser opens a picker only inside one.

Measured on a real library (2,892 `.md` files and 62 others in 235 folders, 24 MB, exported from OneNote): read and planned in under a second, written in about 1.4 s in Chromium.

**Into the scratchpad (2026-10-13, the owner's choices).**
"Import to scratchpad", beside "Import notes" and offered only while the source's scratchpad is shown (an import into a hidden one would put the notes out of sight as they came in), asks the same folder-or-files question and brings in the notes at the top of what was picked, each a card at the top of `.scratchpad/` (`planScratchImport`); a `.scratchpad` folder at the top of what was picked counts as the top, as "Download all notes" writes one.
Choose files offers any file, not only notes and archives, since a note brings the files it links to.
Only the top is read first, then what a note there links to below it; any other file below it is named and not read, nor counted against the most an import reads (`readPicked`'s `scratchpad`), so a few notes beside gigabytes of pictures in folders are a few notes and their pictures.
What comes is planned and written as an import into the source is (`planImport`, `importLibrary`), so what stays out and why, and how it lands, are the same; it adds no folder row and asks for no `mkdir`, as a card written here makes none.
The files those notes link to come too, so a note's pictures still show.
One beside them comes where one of them names it, by the name it was picked by, in a note's body (`namedByAny`, the rule "Attached files" reads links by), and lands beside the cards; one none names is left out and said to be, where any note comes in, as it would only be a file in the scratchpad nothing shows.
One in a folder comes where a note's link reaches it (`linkedFiles`, which a note's move carries its files by), and lands in that folder inside `.scratchpad/` (`.scratchpad/attachments/photo.png`), so the link reaches it there and no note is rewritten — the owner asked for these after first seeing them left out (2026-10-13).
It stays there when its card is made a note: `carryLinkedFiles` carries only the files beside a note, and a link elsewhere is the user's to mend.
A note in a folder is left out, and the question says which and that "Import notes" brings them in with their folders as notebooks, so the user can choose to; any other file in a folder is left out without a word.
Each is said by the path it was picked by.
What the picking left out (hidden, not UTF-8, too large) is said only where it was at the top or a note links to it.
A ZIP of one folder, as a system zips a folder, is taken as that folder's insides (`withoutWrapper`), as picking the folder would: kept as it is, its notes would all be one folder down, and nothing would come in.
An import into the source keeps an archive's tree as it is.
