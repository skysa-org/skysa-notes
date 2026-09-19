---
'@skysa/core': patch
---

A note that reads everything again no longer leaves a ghost behind. When a
re-scan found somebody else's file arriving at one of your notes' names, the
note was moved aside to a conflict name — and then spared the check that asks
which notes the provider no longer has, because the batch had "decided" about
it. Moving a note out of the way says nothing about the file that note holds,
so a note whose own file had been deleted kept its row for good, pointing at
nothing, and showed up as a conflict copy of a note that never conflicted.
Now the displacement counts for nothing there: the note is kept only if its own
file was among what the scan returned. With unsent edits it is kept and cut
loose, as always. A re-scan the provider warns may be missing things still
removes nothing at all.

A push that has to step around another device's file also names the copy
better. The name was picked from this device alone, so a name already taken on
the remote by a file this device had not seen yet cost the push an attempt and
could leave the note with two `(conflict …)` suffixes. Where the note has no
file of its own to stay with, its edit now goes up under that name there and
then, and moves on to the next name if the remote says it is taken.
