---
'@skysa/api': patch
'@skysa/web': patch
---

Sign-in separate from storage is dropped rather than deferred: identity and
storage are coupled, so a person is their storage account.

Two things a user or an operator can see. The refusal for
`AUTH_MODE=account-first` now says the mode is not implemented **and will not
be**, rather than "not implemented yet" — a decision rather than a schedule.
And the client stops carrying three connect outcomes the server retired in
Phase 7: `conflict`, `occupied`, and `signin`, which rendered "Sign in before
connecting storage" for a product that does not exist. A stale link carrying
one of them used to render an empty red banner; now it renders nothing.
