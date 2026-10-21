---
'@skysa/web': patch
---

Changing or removing a link in the rich editor now acts on the whole link, wherever in it the cursor is. A link whose words were partly bold or italic used to come apart: only the words around the cursor got the new address, or lost the link, and the rest kept the old one.
