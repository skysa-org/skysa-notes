---
'@skysa/web': patch
---

The store's three identical scope types are one `ConnectionScope`; composite keys are named (`FileKey`, `FolderKey`, `ClipKey`); and the sync's store asks the queue's own `opsFor`/`opsForFile` for a note's or file's ops.
