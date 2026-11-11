---
'@skysa/web': patch
---

The build's service worker, manifest and brand are now made by the shared kit, `@skysa/pwa`, installed from npm with the rest; the manifest it makes is byte for byte the one before. A deployment's own `brand.json` whose `$schema` names `apps/web/brand.schema.json` should name `apps/web/node_modules/@skysa/pwa/brand.schema.json` instead: the build never reads that path, so until then only an editor's hints are missing.
