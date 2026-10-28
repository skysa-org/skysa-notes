---
'@skysa/api': patch
---

Each API route that acts on a connection now checks the device's credential itself, and the routes get the app's configuration and keys from `createApp` rather than from the request. A path under `/api/connection` that is not a route now answers 404 `not_found` rather than 401.
