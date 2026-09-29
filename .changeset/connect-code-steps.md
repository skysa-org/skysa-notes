---
'@skysa/core': minor
'@skysa/api': minor
'@skysa/web': minor
---

A connect gate's code is checked as it is used. **Breaking** for a gate with
`connectCode`: `createApp` now refuses one whose `EntitlementProvider` has no
`checkCode(code)`, which answers `{ accepted: true, expiresIn }` in seconds (at
most a day) or `{ accepted: false, reason? }`. The app asks it through the new
`POST /api/connect-code`, which is same-origin and rate-limited as
`connect-code:<ip>`, and the callback still decides with `check`.

`connectCode` takes `required`, which leaves no way to the buttons without an
accepted code. The gate is two steps, one open at a time. An accepted code is
held in `localStorage` for as long as the policy said, and the gate folds to a
line naming it until it runs out. A refusal is shown under the field, in the
policy's words where it gave some.
