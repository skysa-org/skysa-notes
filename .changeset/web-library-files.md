---
'@skysa/web': minor
'@skysa/core': patch
---

The library learns files beside notes (#187). `addAttachment` adds a file to a note's folder under a content-stamped name, refusing anything over 25 MB and any `.md`, and queues its upload ahead of the note. Moving a note takes the files it links with it, copying one another note in the old notebook still links, and putting one beside a different file of the same name under a conflict name; moving a notebook moves its files ahead of its notes, and deleting one deletes them, with the count in the confirmation. A file not uploaded yet counts as unsent work when a source is disconnected, keeps its upload while the source is detached, and is forgotten with a source the user discards. A blocked sync names the op that stopped the queue rather than an upload stepped over. In the sync store, an upload that lands for a file moved or deleted meanwhile sends the `rmdir`s over it behind what it now owes, so a notebook let go during an upload does not stay on the remote. Nothing in the editor adds a file yet.
