---
'@skysa/api': minor
'@skysa/web': patch
---

"Connect again" now signs out the credential the device held before, so it no
longer lingers in the device list for 180 days as a device that is not one and
a live key to the account.

On the server, revoking the last live device of an account disconnects it: the
row is deleted and the grant withdrawn at the provider where there is a call
for it, rather than being left as a live refresh token nothing can reach or
revoke. `DELETE /api/connection/grants/:id` answers `disconnected` (and
`revoked` when it is) alongside `ok`. The web app's device list only removes
*other* devices, so this is reached through the API; an account whose only
device clears its site data is still not cleaned up.
