---
'@skysa/web': patch
---

The app open in a background browser tab no longer stops the installed app, or another tab, from opening notes. A tab the browser had frozen held the device's notes database each time another tab saved, so notes would not open and sync said "Syncing…" until that tab was closed. A frozen tab now lets go of the database and picks it up again when it is next used.
