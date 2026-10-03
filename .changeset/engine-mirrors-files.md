---
'@skysa/core': minor
---

The sync engine mirrors files that are not notes on pull (#187). Each listed file becomes a row, matched by id, or adopted from a pending row at its path of the same size; nothing is downloaded. The remote keeps the path: a pending row, or one the user moved there, steps aside under a conflict name that keeps its extension. A file the user is deleting is passed over, and one the user is moving stays where they put it. A file deleted there goes, unless the user moved it here, when it is sent again from the bytes held here. Folder deletions take bound rows and keep pending ones, a note renamed into a file lets the note go and the other way round, and a scan drops the bound rows it did not find.
