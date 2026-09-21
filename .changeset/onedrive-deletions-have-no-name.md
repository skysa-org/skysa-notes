---
'@skysa/core': patch
---

The OneDrive wire stub no longer puts a `name` on a deleted item. Graph sends
none — verified against a live personal account, which is the case the stub's
`businessDeletes` option implied was different and is not. A deletion arrives
as its id, its `parentReference`, the `deleted` facet and a file/folder facet,
and nothing else.

Nothing depended on it: the adapter resolves a deletion by id through its
cursor tree and never reads the name. The option is gone, and the test that
used it now describes the ordinary case rather than a Business one. Test
helpers only — no behaviour change.
