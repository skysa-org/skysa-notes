---
'@skysa/api': minor
'@skysa/web': patch
---

A storage account no device can reach is no longer left on the server holding a
live refresh token. Signing out the last device that reaches an account now
disconnects it: the grant is withdrawn at the provider where there is a call
for it and the row is deleted. `DELETE /api/connection/grants/:id` answers
`disconnected` (and `revoked` when it is) alongside `ok`. "Connect again" also
signs out the credential the device held before, so it no longer lingers in the
device list for 180 days as a device that is not one.
