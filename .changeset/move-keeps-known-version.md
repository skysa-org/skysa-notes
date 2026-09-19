---
'@skysa/core': patch
---

Renaming a note on one device while another device edits it could lose that
edit, or leave the renaming device showing the old text. After moving a file the
engine kept the version the provider handed back, which is the version of bytes
it had never read: a pull then skipped the file as already seen, and a write
queued in front of the rename was checked against the other device's edit,
passed, and overwrote it with no conflict copy. The engine now keeps a version
after a move only over bytes it knows — it reads the file where the provider
changes the version on a move (OneDrive, Google Drive) — and otherwise goes on
holding the one it had, so the next pull reads the file and an edit on both
sides is kept as a conflict. Found by the two-browser soak test, seeds 578 and
461.
