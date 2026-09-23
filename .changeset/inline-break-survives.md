---
'@skysa/web': patch
'@skysa/core': patch
---

A `<br />` inside a sentence no longer sends the note to markdown mode. The
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
