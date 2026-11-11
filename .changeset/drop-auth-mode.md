---
'@skysa/api': major
'@skysa/core': major
'@skysa/web': patch
---

`AUTH_MODE` and `WEBDAV_ALLOW_PRIVATE` are no longer read, and the server's migration `0007_drop_sign_in_tables` drops the `users` and `identities` tables, which nothing ever read (#118; the kit at 0.2.0). Remove `AUTH_MODE` from `[vars]` in your `wrangler.toml`, and either setting from `.dev.vars` or your secrets if it is there: the Worker still boots with them, and logs a line at boot asking for each to be removed. `AUTH_MODE=account-first` is still refused at boot. The migration is applied by the routine steps. An app from before this release keeps working against the new server, which still sends the field that app reads. Code of your own that imported `AUTH_MODES` or `AuthMode` from `@skysa/core` drops them: there is nothing left to choose.
