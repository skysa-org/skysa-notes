---
---

`pnpm typecheck` in apps/api also checks the Worker's source on its own, without Node's types, so a Node-only global there fails the check instead of the deployed Worker. Tooling only; nothing a user or operator sees changes.
