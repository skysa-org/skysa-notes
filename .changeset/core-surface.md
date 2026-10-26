---
'@skysa/core': patch
---

`@skysa/core` now names what it offers instead of re-exporting whole modules, and its test doubles (the in-memory provider, the provider stubs, the store contract) moved to `@skysa/core/testing`. Nothing the app does changes. Code outside this repository that imports `@skysa/core` keeps every name the apps use and the types an `EntitlementProvider` or `RateLimiter` is written against; `createFakeProvider` is now imported from `@skysa/core/testing`.
