---
'@skysa/core': patch
'@skysa/web': patch
---

A file added to the clipboard keeps its name: "Q3 Report.pdf" is shown and saved as "Q3 Report.pdf", not "q3-report.pdf". Only characters a storage provider or a disk refuses are replaced, and the extension is lowercased. Items already on the clipboard keep the names they have.
