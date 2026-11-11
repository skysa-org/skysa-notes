---
'@skysa/api': major
---

The server is now the shared kit's, `@skysa/server`, installed from npm with the rest; `apps/api` keeps the Worker's entry and its `wrangler.toml`. With the stock entry and `apps/api/wrangler.toml` there is nothing to do beyond the routine steps. A Worker entry of your own that imported from files beside `src/worker.ts` (`./app.js`, `./env.js`, `./http.js`, `./relay/durableObject.js`) imports `createApp`, `parseEnv`, `envWarnings` and `misconfigured` from `@skysa/api` instead, and `ConnectionRelay` and `durableObjectRelay` from `@skysa/api/relay`; one that already imported from those builds unchanged. A `wrangler.toml` of your own points `migrations_dir` at `node_modules/@skysa/server/migrations` in its package: the migrations are the same files under the same names, so a database migrated before finds nothing new to apply. `pnpm db:generate` is gone with the schema it read.
