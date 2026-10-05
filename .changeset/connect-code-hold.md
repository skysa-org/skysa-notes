---
'@skysa/core': minor
'@skysa/api': minor
'@skysa/web': minor
---

An operator's `checkCode` may answer an accepted code with `hold`, a value the app keeps and sends in place of what was typed, for up to a year: a pass for the device, say, so a code good for minutes is typed once per device rather than once per sitting. The app never shows a held value (the gate says the code was accepted on this device, and Change opens an empty field), and asks about what it holds again once as it loads, keeping the answer and letting go of a value the policy refuses. A code, or a held value, may now be up to 256 characters. The self-hosting guide's code gate example gains the `checkCode` it needs.
