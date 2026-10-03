---
'@skysa/web': patch
---

The app can read a file beside a note for showing it (#187), though nothing shows one yet. A file this device holds is answered from the device; any other is downloaded through the source being synced, at most two at once and once however many ask, and kept in a cache of 250 MB that lets go of the least recently used first. It never lets go of a file not uploaded yet, nor of the files of a disconnected source or of one not yet checked against its storage. A file the storage no longer has is reported as gone and left for the next sync to remove. Object URLs for showing files are shared between views and revoked a few seconds after the last one goes.
