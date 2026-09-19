---
'@skysa/web': patch
---

Groundwork for disconnecting a source without leaving notes where nobody can
see them. Nothing a user can see has moved: the app can now say what a source
holds that its remote has not been sent, have the editors write what they are
holding and report what would not save, and build a ZIP of notes for download —
none of which is called from the interface yet. The one change to stored data is
that each connected source's row now remembers what the server last called the
account, so a source can still be named once the server stops answering for it.
