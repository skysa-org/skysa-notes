---
'@skysa/core': minor
'@skysa/web': minor
---

Notes are keyed by connection and id, so two connected sources can each hold a
note of the same id — which they do whenever one folder has been copied into
two accounts, since the id travels in the file.

The local database moves to schema version 5 on first open. Every note is
carried over as it was; the upgrade is a single transaction, so a failure
leaves the database as it found it. A tab still running the previous build is
stopped and asks to be reloaded.

A file whose id another source already holds now syncs under the id it names.
It used to be given a made-up id, and the two sources then took turns writing
their own id into the file.

`SyncStore.idHeldElsewhere` is removed from the core port: a store's ids are
its connection's own, and the engine no longer asks. When two sources that
held a note of one id are both disconnected, the second to arrive in the local
pile is given a fresh id and keeps its queue.
