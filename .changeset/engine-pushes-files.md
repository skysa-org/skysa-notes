---
'@skysa/core': minor
'@skysa/web': patch
---

The sync engine pushes files that are not notes (#187). An `upload` sends a pending file's bytes, or copies them from the remote file it copies, making the folders it needs. The same file already at its name is taken for its own, unless another row holds it or a queued delete is to take it. Anything else there keeps the name, and the upload goes beside it under a conflict name that keeps its extension, chosen from one listing of the folder. A `move-file` moves a file by id, and a `delete-file` deletes one. Uploads do not hold up the queue: one that fails is counted and stepped over, then sent after everything else on later pushes; one out of attempts is kept and reported; and the outcome carries `waitingUploads`. A delete that a waiting copy still needs is held back, and so are an `rmdir` over it and an upload or move to its name. An `rmdir` leaves a notebook that still holds a file row. The web store no longer carries cached bytes to a file a move took for its own. New exports: `contentTypeOf` and `conflictFilePath`.
