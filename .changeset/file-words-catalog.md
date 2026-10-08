---
'@skysa/core': patch
'@skysa/web': patch
---

The words the app writes into the user's files where a name gives none, the alt text of a pasted picture, the link text of a file with no name and the folder of a notebook given no usable name, now come from the app's catalog. `@skysa/core` takes them from its caller (`attachmentLabel`'s `words`, `sanitizeFolderName`'s `unnamed`). A note with no name stays `untitled.md` and `UNTITLED_TITLE` in every language, and is shown in the catalog's words (`notes.untitled`). `ClipName.label` is now `undefined` for a pasted text or a picture with no name of its own, and `fileKindLabel`, which nothing used, is gone. The English is unchanged.
