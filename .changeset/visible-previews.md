---
'@skysa/core': patch
'@skysa/web': patch
---

A note's preview in the list, and its excerpt in search answers, are the text
the rich editor shows — `**bold**` reads "bold", a link reads as its words
without its URL — rather than the markdown with only its line markers removed.
In the list, a pipe stands where one line of the note ends and the next
begins, so two lines no longer read as one sentence.
