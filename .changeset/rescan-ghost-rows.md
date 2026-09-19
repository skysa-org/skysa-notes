---
'@skysa/core': patch
---

A note that reads everything again no longer leaves a ghost behind. When a
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
