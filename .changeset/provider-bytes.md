---
'@skysa/core': minor
---

Every storage adapter can now upload and download a file's bytes exactly as they are, not only a note's text: `readBytes` and a create-only `createFile` join the provider port, with Google Drive switching to a resumable upload above 5 MB. Nothing in the app calls them yet; they are the ground attachments are built on (#187). A file's `size` is now documented as bytes on every file entry, a conflict's included.
