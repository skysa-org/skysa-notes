---
'@skysa/web': patch
---

Only the app's own database watches the tab (for a newer build, for being frozen, and for being held up by another tab). A database made beside it no longer leaves a `freeze` listener on the page behind it.
