---
'@skysa/core': minor
'@skysa/web': patch
---

Search no longer finds a note by a secret's encrypted text. A short search could match a run of a secret's base64 by chance, or the `age` its fence opens with; the index now holds each secret as its label alone, so a note is still found by its secrets' labels. `withoutArmor` (core) gives a note's body that way.
