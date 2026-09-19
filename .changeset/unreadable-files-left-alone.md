---
'@skysa/core': patch
'@skysa/web': patch
---

A file in the notes folder that is not UTF-8 text — saved as Latin-1 or UTF-16
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
