---
'@skysa/web': patch
---

Clicking a notebook no longer clears the open note when the note is in it, or
in a notebook inside it. Clicking the parent of the notebook a note was in used
to leave an empty editor beside the list. When the open note is somewhere else,
or nothing is open, the notebook's most recent note opens instead, so a
notebook with notes in it never opens as a blank pane. Deleting the open note
does the same: the most recent of what is left in the notebook opens, and the
pane is empty only when the notebook is.
