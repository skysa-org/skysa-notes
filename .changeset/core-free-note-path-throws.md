---
'@skysa/core': patch
---

A note that has to step aside to a conflict name, and finds all of its hundred tries taken, now fails its op so it is retried, as a folder already did. Before, it took the next name without checking it, which could put it on another note's path.
