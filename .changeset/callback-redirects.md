---
'@skysa/api': patch
---

The OAuth callback sends the browser back to the app, as a failed connect, where it used to answer in raw JSON: a provider the deployment does not offer or has turned off, a callback with neither a code nor an error, and a throttled callback.
