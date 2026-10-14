---
'@skysa/web': minor
'@skysa/core': minor
---

Secrets in the raw editor. A secret's fence shows its encrypted text as it is written, with Reveal at the end of its first line (or Alt+Enter inside it), which opens the same panel as in the rich editor, under the fence. What you type there is encrypted into the fence as you type it, and one undo takes back what was typed. "Insert secret" in the palette works in raw mode too, and writes a new fence after the paragraph, heading or code block you are in, inside its list or quote; Cancel leaves the note exactly as it was. Find in raw mode passes over a secret's fence, so a search never lands in it and Replace never changes it. A scratchpad card shows "Secret" where its note has one, and a scratch note holding only a secret or only a picture is no longer deleted when the "Take a note" box closes. A sync that changes the note elsewhere no longer moves the cursor or takes the focus from an open secret. In `core`, `previewBlocks` gives a secret a line of its own that carries a secret's mark, including one cut short by a preview's length.
