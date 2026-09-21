---
'@skysa/core': patch
---

A folder created on Dropbox is reported as a folder. `create_folder_v2` answers
with a bare `FolderMetadata`, which — alone among the endpoints the adapter
reads entries from — carries no `.tag`, so the shared mapper called every folder
the app made a file. Nothing downstream read that field, so no stored data was
wrong, but the adapter was not honouring `StorageProvider`.

Found by running the contract suite against a real Dropbox account, which also
showed why no offline test could have caught it: the wire stub had been tagging
the response Dropbox leaves untagged. The stub now answers as Dropbox does.

Two scenarios in the suite turn out never to have tested what they claim,
because both made a version up. Dropbox validates the shape of a `rev` before
comparing it, and — the part that matters — an `update` carrying a rev it has
never issued has nothing to conflict against, so against a missing path it
quietly creates the file. The conflict scenario now takes a per-provider
`staleVersion`, and the missing-file scenario seeds a file, deletes it, and
writes with the version that file really had, which is the only way the engine
ever reaches that path.
