---
'@skysa/core': patch
---

Saving a note no longer respells frontmatter the app did not change. Writing
any one key used to re-serialise the whole block, so `zip: 02134` came back as
`2134`, `0x1F` as `31`, a twenty-digit integer short of its last digits, and a
`created: 2024-09-14` the user wrote as a full timestamp; list layout and
spacing went the same way.

Only the keys whose value actually changes are rewritten now, and everything
else keeps the characters the file had — comments, quoting, key order and blank
lines included. A write that changes nothing returns the block byte for byte.
`updated` is still rewritten on a save, because the app does change it.

A `created` the app cannot read as a date (`created: last spring`) is left as
written, rather than being replaced by the time the file was first imported.
