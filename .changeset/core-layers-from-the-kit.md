---
'@skysa/core': major
---

The provider adapters, the sync engine and the shapes the app and the Worker both speak are now the shared kit's, `@skysa/storage`, `@skysa/sync` and `@skysa/protocol`, installed from npm with the rest; `@skysa/core` keeps this app's own: its folder, the markdown, names, files, secrets and the vault. Code of your own that imports the entitlement, connect-gate and rate-limit names, `PROVIDER_KINDS`, `MAX_CONNECT_CODE` or another of the protocol's names from `@skysa/core` builds unchanged, since core still offers them. Anything else it imported from there that moved — a provider, the engine, `cell`, the marker — it imports from the kit's package by the same name, and `@skysa/core/testing` is gone: the test doubles are each kit package's `/testing` entry.
