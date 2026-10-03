---
'@skysa/web': patch
---

A request to a storage provider is no longer given up on after a minute regardless of size: it gets 1 ms more for every 50 bytes it sends or receives — 50 KB/s, the slowest connection a file is still expected to cross — counted from the answer's `Content-Length`, or as its bytes arrive where it gives none. A note or a page of changes keeps the minute. This makes room for attachments of up to 25 MB (#187).
