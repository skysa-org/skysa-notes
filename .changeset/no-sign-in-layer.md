---
'@skysa/api': patch
---

The refusal for `AUTH_MODE=account-first` now says the mode is not implemented
**and will not be**, rather than "not implemented yet". Sign-in separate from
storage was dropped: identity and storage are coupled deliberately, so an
operator reading that message is being told a decision rather than a schedule.
