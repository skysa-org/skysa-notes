---
'@skysa/web': minor
---

The library learns files beside notes (#187). `addAttachment` adds a file to a note's folder under a content-stamped name, refusing anything over 25 MB and any `.md`, and queues its upload ahead of the note. Moving a note takes the files it links with it, copying one another note in the old notebook still links; moving a notebook moves its files, and deleting one deletes them, with the count in the confirmation. A file not uploaded yet counts as unsent work when a source is disconnected. A blocked sync names the op that stopped the queue rather than an upload stepped over. Nothing in the editor adds a file yet.
