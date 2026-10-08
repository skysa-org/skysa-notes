---
'@skysa/web': patch
---

The sidebar builds its tree in one pass and draws a notebook's row again only when that row changes, so an autosave, a sync run or a drag over the notebooks no longer redraws every row of a large library.
