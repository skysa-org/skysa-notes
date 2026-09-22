---
'@skysa/web': patch
---

Fix a notebook moved to another notebook — or out to the top level — leaving a duplicate of itself and everything under it behind, on the remote as well as in the sidebar. Moving or deleting a notebook queued one directory removal, for the outermost directory only; every directory below it had nothing naming it, so the sync that ran next adopted them as new notebooks before the push could remove them, and the removal was then refused because the device held a notebook under that path again. Each directory now gets its own op. The whole-app sync suite also runs over Dropbox now, which it did not before.
