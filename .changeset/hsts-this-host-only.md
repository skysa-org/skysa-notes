---
'@skysa/web': patch
---

The shell's `Strict-Transport-Security` header no longer says
`includeSubDomains`. Served from an apex domain it committed every subdomain the
operator owns to HTTPS for two years; that is theirs to decide, and
`docs/self-hosting.md` says how to add it back. The Node floor is 22.13, the
first 22.x where `node:sqlite`, which the API tests use, needs no flag.
