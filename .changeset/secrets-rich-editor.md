---
'@skysa/web': minor
'@skysa/core': minor
---

Secrets in the rich editor. A secret shows as a closed block that says "Secret" and offers Reveal, which unlocks the device if it is locked and opens the words in a panel under the block, with Copy, Cancel and Done. What you type there is encrypted into the note as you type it, so closing the note, switching mode, the app locking or a sync never finds words that are not saved; Done closes the panel, and Cancel puts the secret back as it was. "Secret" in the slash menu, and "Insert secret" in the palette, write a new one. When the app locks, every open secret closes. A secret copied and pasted, or pasted as markdown, is a secret still. In `core`, sealing and opening an age file no longer wait: `encrypt`, `decrypt`, `opens`, `sealSecret`, `openSecret` and `opensSecret` answer at once, with HKDF and HMAC from `@noble/hashes`.
