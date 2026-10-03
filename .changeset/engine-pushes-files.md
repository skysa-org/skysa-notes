---
'@skysa/core': minor
---

The sync engine pushes files that are not notes (#187). An `upload` sends a pending file's bytes, or copies them from the remote file it copies, making the folders it needs; the same file already at its name is taken for its own, and anything else there keeps the name while the upload goes beside it under a conflict name that keeps its extension. A `move-file` moves a file by id, and a `delete-file` deletes one. Uploads do not hold up the queue: one that fails is counted and stepped over, one out of attempts is kept and reported, and the outcome carries `waitingUploads`. An `rmdir` leaves a notebook that still holds a file row. New exports: `contentTypeOf` and `conflictFilePath`.
