---
'@skysa/web': patch
---

The service worker answers a navigation with the app shell only for the app's
own route, `/` with or without a search. Every other path on the origin goes to
the network, so a page served beside the app, such as the one a gate's action
links to, opens as itself rather than as the app's "Not found" in a browser
that has run the app before.
