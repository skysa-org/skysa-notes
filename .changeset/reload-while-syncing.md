---
'@skysa/web': patch
---

"A new version is available" → Reload works while the app is syncing. It used to seem to do nothing, sometimes for as long as five minutes. It now pauses syncing in every open window of the app for a moment, then switches to the new version and reloads, and says "Updating…" while it does. Updating to this version may still need a quiet moment: if Reload seems stuck, close every window of the app and open it again.
