---
'@skysa/api': patch
---

Each API route that acts on a connection now checks the device's credential itself, and the routes get the app's configuration and keys from `createApp` rather than from the request. A request under `/api/connection` for a path or method that is not a route now answers 404 `not_found` rather than 401. Nothing to do for an instance run from `src/worker.ts`; a second Worker entry with middleware of its own that read the app's configuration, seams or keys from the request (`c.get('config')` and the like) reads them from what it passed to `createApp`.
