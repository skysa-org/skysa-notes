---
'@skysa/core': patch
---

A secret in a note, an `age` block holding age's armor, is left out of the note list's preview, the scratchpad's cards and search, which would otherwise show its base64. The age format itself (X25519 keys, the header, the payload and the armor) is now in core, checked against age's published test vectors. The app does not use it yet.
