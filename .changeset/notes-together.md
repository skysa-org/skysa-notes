---
'@skysa/core': minor
'@skysa/web': patch
---

A sync to Google Drive sends up to four notes at once rather than one at a time, so a large import reaches it several times faster. A provider says how many it takes (`StorageProvider.writesAtOnce`); Dropbox and OneDrive still take one, since Dropbox refuses writes that meet one another as a rate limit. Notebooks, moves, deletions, files beside notes, and the write of a note with a rename queued still go one at a time, in order, and a notebook missing under notes sent together is made once between them. Requests that find the access token expired at the same moment now share one new token.
