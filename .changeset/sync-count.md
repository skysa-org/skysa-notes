---
'@skysa/core': minor
'@skysa/web': minor
---

A long sync now says how far it has got. The engine counts a round from a stored cursor as it receives it (`SyncProgress` gains a `receiving` stage), so a device picking up another's import of a thousand notes is no longer silent until all of it lands. The storage panel shows a run of twenty or more as a count in its status line — "Sending 120 of 1,000", "Receiving 5 of 30", "Looking for notes: 40 found" — with a bar under it and the file it is on in the line's tooltip; in a compact window the panel says it in a sentence over the bar.
