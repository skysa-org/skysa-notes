---
'@skysa/web': minor
'@skysa/core': minor
---

Secrets in the raw editor. A secret's fence shows its encrypted text as it is written, with Reveal at the end of its first line (or Alt+Enter inside it), which opens the same panel as in the rich editor, under the fence. What you type there is encrypted into the fence as you type it. "Insert secret" in the palette works in raw mode too, and writes a new fence after the line you are on. Find in raw mode passes over a secret's encrypted text, so a search never lands in it and Replace never changes it. A scratchpad card shows "Secret" where its note has one. In `core`, `armorSpans` finds where armored age text is in a string, and `previewBlocks` gives a secret a line of its own that carries a secret's mark.
