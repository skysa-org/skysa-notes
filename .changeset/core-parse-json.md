---
'@skysa/core': patch
---

Core reads JSON from outside through one `parseJson` and `isJsonObject`/`asObject` (`src/json.ts`), in place of nine hand-rolled try/catch parses.
