---
'@skysa/web': minor
---

Disconnect signs out only the device it is pressed on. Other devices connected to the same account keep syncing, and the last device out disconnects the account and withdraws its access at the provider, as before. The disconnect question says which of the two it will be. Cancelling a first import signs out the same way. The API client's `disconnect()` is replaced by `signOut()`.
