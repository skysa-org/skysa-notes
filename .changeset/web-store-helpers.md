---
'@skysa/web': patch
---

The app's in-memory stores (tab state, renames, install prompt, secrets lock, code display, formatting, and the rest) share one `createEmitter` and `createStore` in place of a listener set written out in each.
