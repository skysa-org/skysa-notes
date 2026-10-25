---
'@skysa/core': patch
---

The Dropbox adapter refuses the root as the other adapters do: a note or file written at `''`, or a move onto it, is a `NotFoundError` rather than Dropbox's own 400, and `createFolder('')` answers the app folder instead of failing.
