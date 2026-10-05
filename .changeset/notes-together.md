---
'@skysa/core': minor
'@skysa/web': patch
---

A sync sends up to four notes at once rather than one at a time, so a large import reaches Google Drive, OneDrive or Dropbox several times faster. Notebooks, moves, deletions and files beside notes still go one at a time, in order, since what comes after them depends on them.
