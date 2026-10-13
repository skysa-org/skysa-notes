---
'@skysa/core': patch
'@skysa/web': patch
---

While a sync reads what has changed on another device, the status says so. It used to say just "Syncing…" until it started counting notes, which after a lot of notebooks were moved on another device could take minutes. Now the line says "Checking for changes…" from the start, and once it has found twenty or more changed notes, how many so far, with a bar. A re-scan says "Looking for notes…" before it has found any. For other code using `@skysa/core`: the `receiving` progress now carries `listing`, which is true while the pages of changes are still being read.
