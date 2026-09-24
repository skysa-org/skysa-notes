---
'@skysa/core': minor
'@skysa/api': minor
'@skysa/web': minor
---

An operator can gate connecting. `EntitlementProvider` takes an optional
`gate` — a message and one `https:` link — which `createApp` checks when it is
built and `/api/config` serves as `connectGate`. The app shows it where the
provider buttons are: a device with an account syncing on the instance sees the
buttons with the gate beside them, and any other sees the gate with an "Already
have access? Connect storage" control that shows them.

A refusal can say which kind it was: `EntitlementDecision.code` is one of
`ENTITLEMENT_CODES` (`not_allowed`, `lapsed`, `limit_reached`), carried by the
callback as `?connect=refused&code=…` and by `/token` beside `reason`; any other
value is dropped. The refused toast and the storage panel word the refusal by
it, the panel shows the operator's reason, and both offer the gate's link.
