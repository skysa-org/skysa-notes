---
'@skysa/core': minor
'@skysa/api': minor
'@skysa/web': patch
---

An operator's `EntitlementProvider` is asked at the OAuth callback as well as at
`/api/token`, before anything is stored. An account it refuses no longer leaves
a refresh token sealed in the database: nothing is stored, the consent just
given is withdrawn where the provider has a call for it, and the app says the
account cannot sync on this server. For operators: `EntitlementSubject`'s
`connectionId` is now optional, and is absent when the account is connecting
for the first time.
