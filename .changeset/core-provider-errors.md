---
'@skysa/core': patch
---

An answer a provider should not have given — an item with no id, a file with no version, a page with neither link — is now a `ProviderResponseError`, still without a code, so a log can tell it from an outage. The three adapters' rate-limit errors read alike: `<provider> rate limit (<status>)`, the provider's reason where it gave one, and the wait it asked for.
