---
'@skysa/core': major
---

`@skysa/core` now names what it offers instead of re-exporting whole modules, and its test doubles (the in-memory provider, the provider stubs, the store contract) moved to `@skysa/core/testing`. Nothing the app does changes, and an instance deployed with the routine steps needs nothing more.

**What to do if your own code imports `@skysa/core`** (a deployment's `EntitlementProvider` or `RateLimiter`, say): every name the apps use is still offered, and so are the types those two seams are written against (`EntitlementContext`, `EntitlementDecision`, `EntitlementSubject`, `RateLimitDecision`). Import `createFakeProvider` and its types from `@skysa/core/testing` instead, and only from tests. 53 values and 34 types nothing in the repository used are no longer offered; if your code imported one of them, it fails to typecheck on update, and the fix is to name it in `packages/core/src/index.ts` (and in `tests/exports.test.ts`, which lists what the entry offers) or to stop depending on it.
