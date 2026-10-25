---
'@skysa/web': patch
---

The editors and components that keep the latest callback or value in a ref get it from one `useLatest` hook, in place of twenty-one copies of the same ref-and-effect pair.
