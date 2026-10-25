---
'@skysa/web': patch
---

Whether a note is live or a tombstone, and whether a source syncs or is detached, is asked through `isLive`, `isTombstone` and `isLiveSource` (`store/rowStates.ts`) in place of the flags compared by hand.
