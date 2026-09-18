---
'@skysa/core': patch
'@skysa/web': patch
---

Fixes from a whole-codebase review. Nothing here changes the file format or the
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

Saving. A save that fails is said, in the note, and retried, where it used to
be dropped silently. A tab left open across a schema upgrade made by a newer
build in another tab now finishes its writes, closes, and asks to be reloaded,
rather than carrying on writing with old code into the migrated database.

Files. An `id:` the user wrote that the app cannot use (`id: 202409141302`) is
left as written instead of being replaced by a UUID on first save, in the note
and in a conflict copy of it. A frontmatter block closed by `...` is read as
one, and an unclosed block no longer swallows prose up to the next `---`. File
names are cut between grapheme clusters and capped at 216 bytes as well as 120
code points, so an emoji at the boundary cannot produce a name OneDrive's
adapter throws on; existing files are not renamed.

Shell. A crafted `?note=` link can no longer crash the app — search params a
route refused were reaching components anyway — and a render error now shows a
screen saying the notes are safe, with Reload and Try again. In the storage
panel, "Stop syncing on this device" after a failed disconnect can no longer be
pressed under a different source than the one that failed.
