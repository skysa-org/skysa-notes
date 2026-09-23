---
'@skysa/web': patch
---

A table with an empty cell no longer sends its note to markdown mode. The rich editor wrote every empty cell back as `<br />`, a break the note never had, so the check that keeps it from rewriting a note refused the whole note. An empty cell is now written empty, including in a table made in the rich editor, and a `<br />` written into a cell is still kept as it was.
