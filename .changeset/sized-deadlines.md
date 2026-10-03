---
'@skysa/web': patch
---

A request to a storage provider is no longer given up on after a minute regardless of size: it gets longer for every byte it sends, and longer again once the answer says how many bytes it holds, at 50 KB/s, the slowest connection a file is still expected to cross. A note or a page of changes keeps the minute. This makes room for attachments of up to 25 MB (#187).
