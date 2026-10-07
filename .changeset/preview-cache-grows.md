---
'@skysa/web': patch
---

A notebook or scratchpad with more than 400 notes no longer parses every note's preview again each time its list is drawn, which it was doing on every autosave of the note beside it. The cache of previews now grows with the lists on screen, and a scratchpad card's text is parsed once instead of twice.
