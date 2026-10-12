---
'@skysa/web': minor
'@skysa/core': patch
---

Links in a note can now be opened. When the cursor is in a link, a chip under it shows where the link goes, and pressing the chip opens it. With a mouse or trackpad, the chip also says you can ⌘-click a link (Ctrl-click on Windows and Linux) to open it straight away. Alt+Enter opens the link the cursor is in. This works in both rich text and Markdown mode, and a bare web address, `www.` address or e-mail address in Markdown mode counts as a link, as it already did in rich text. On a scratchpad card, pressing a link's words opens the link instead of the card. Links open in a new browser window, not inside the installed app. Only web, e-mail and phone links open. A link to another note does not open yet.
