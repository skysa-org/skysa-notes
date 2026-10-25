---
'@skysa/web': patch
---

The transactions that open many tables share their table lists from `store/scopes.ts` (`writerTables`, `libraryTables`, `sourceTables`), at the widths they had; a test holds every table kept by source in `sourceTables`.
