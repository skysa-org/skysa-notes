---
'@skysa/core': minor
'@skysa/web': patch
---

The sync store learns files that are not notes (#187): a row per file, bound to the remote or pending upload, with its bytes kept apart and handed back only while they are still the file's. `SyncStore` gains `fileById`, `fileByPath`, `fileByRemoteId`, `allFiles`, `filesUnder` and `fileBytes`; a pull can put, move aside, delete and re-upload a file; a folder move and delete take files with them, leaving a pending one; and an upload, a file move and a lost file each have an outcome. The web app's database gains `files` and `fileBytes` tables.
