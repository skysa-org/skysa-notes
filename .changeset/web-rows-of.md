---
'@skysa/web': patch
---

A source's rows are read through one `rowsOf(table, connectionId)` (`store/rows.ts`), in place of ninety `.where('connectionId').equals(…)`; the queries are the same.
