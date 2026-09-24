---
'@skysa/web': minor
---

"Download all notes", in the command palette and the storage panel, saves the
source showing as one zip of markdown: every note as the file a push would
send, at the path it would have, and every empty notebook as a folder. On a
device with nothing connected it is the one way to get the notes out of the
browser. An archive past the format's limits (65,534 entries, 4 GiB) is refused
in words rather than handed over broken.
