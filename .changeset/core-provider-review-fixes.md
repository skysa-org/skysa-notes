---
'@skysa/core': patch
---

No adapter deletes, leaves or moves the app's own folder, whether it is named by its path or by its id: asked to, each refuses with a `NotFoundError`, as it already refused a file written at the root. Google Drive would otherwise have trashed the folder and everything in it, or moved it. A provider's success answer that is not a JSON object is now a `ProviderResponseError` naming the provider, not a `SyntaxError` or a `TypeError`, and Dropbox's rate-limit error says what Dropbox called it, as the other two do.
