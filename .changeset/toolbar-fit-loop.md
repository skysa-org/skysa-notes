---
'@skysa/web': patch
---

Resizing the window no longer crashes the note at some widths, around 1080px on a desktop. At those widths the formatting toolbar could not settle on which buttons fit, moved one into its "More tools" menu and back for ever, and React gave up on the page. The toolbar now settles at once at every width.
