---
'@skysa/core': patch
---

Saving a note no longer respells frontmatter the app did not change. Writing
any one key used to re-serialise the whole block, so `zip: 02134` came back as
`2134`, `0x1F` as `31`, a twenty-digit integer short of its last digits, and a
`created: 2024-09-14` the user wrote as a full timestamp; list layout and
spacing went the same way.

Only the keys whose value actually changes are rewritten now, and everything
else keeps the characters the file had — comments, quoting, key order and the
blank lines between keys included. `writeFrontmatter` hands back the YAML it
was given, byte for byte, when the patch changes nothing. `updated` is still
rewritten on a save, because the app does change it.

A `created` the app cannot read as a date (`created: last spring`) is left as
written, rather than being replaced by the time the file was first imported.

A comment under a key with no value (`tags:` as a template leaves it) stays
where it was when that key is filled in or removed, and a comment on the line
of a tag list survives new tags. A value that another line reads through a
YAML anchor (`title: &t a`) is not written over, and a block `yaml` cannot
evaluate is handed back unchanged instead of throwing.
