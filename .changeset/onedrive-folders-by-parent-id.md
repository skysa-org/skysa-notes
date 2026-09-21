---
'@skysa/core': patch
---

Folders can be created on OneDrive at all. The adapter addressed a new
folder's parent by path, and Graph answers a `POST .../children` whose parent
is addressed that way with a bare `400 invalidRequest` — at every depth,
including the app folder itself, whatever the name and `conflictBehavior` say.
The parent now goes in by id, which Graph accepts.

Nothing about this was visible offline: the wire stub accepted the path form,
so the whole contract suite passed against an adapter that could not make a
single folder on a real account. The stub now refuses it as Graph does, and
fails the eight scenarios the live account failed.

The blast radius was everything with a folder in it — `mkdir`, and so the
first notebook a device syncs, and every move, delete and scan that needed
one. Reads were unaffected (`GET .../children` by path is fine) and so were
files (`PUT approot:/{path}:/content`), which is why an app folder could end
up holding its marker file and nothing else while sync retried and blocked.
