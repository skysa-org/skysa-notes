---
'@skysa/core': minor
'@skysa/api': minor
'@skysa/web': minor
---

An operator's gate can ask for a code. `ConnectGate` takes an optional
`connectCode: { label }`, and the app shows a field under that label where the
gate is, in front of the provider buttons and beside them. What is typed is
held for the tab, sent with `/start` as `connectCode` (trimmed, at most
`MAX_CONNECT_CODE` characters), carried to the callback in the signed flow
cookie, and handed to the policy there as `check(subject, { connectCode })`.
`/token` never passes it. A plain refusal of a connect that carried a code reads
"The code you entered was not accepted", and the code is dropped.
