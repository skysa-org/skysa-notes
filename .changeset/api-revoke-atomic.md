---
'@skysa/api': patch
---

Signing out the last device of an account now removes the account's stored access in the same step. A sign-out cut off part way, by a tab closed at the wrong moment, could before leave that access stored on the server with no device able to use or remove it.
