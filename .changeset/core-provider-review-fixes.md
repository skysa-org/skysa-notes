---
'@skysa/core': patch
---

No adapter deletes or leaves the app's own folder: asked to, each refuses with a `NotFoundError`, as it already refused a file written at the root. Google Drive would otherwise have trashed the folder and everything in it. A provider's success answer that is not JSON is now a `ProviderResponseError` naming the provider, not a `SyntaxError`, and Dropbox's rate-limit error says what Dropbox called it, as the other two do.
