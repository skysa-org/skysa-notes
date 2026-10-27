---
'@skysa/api': patch
---

`GET /api/relay` checks the request's origin first: a cross-origin request is refused 403 whether or not the relay is on, rather than learning from a 404 that it is off.
