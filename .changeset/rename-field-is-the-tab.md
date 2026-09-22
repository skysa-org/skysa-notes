---
'@skysa/web': patch
---

Renaming a source tab no longer changes the shape of the tab. The field wears
the tab's own box — the same padding, type and lit edge — and carries none of
its own: no padding, no background, no border, no focus ring. Before this it
drew a second, smaller, bordered box inside the tab and shifted the name
sideways as it opened.

Nor does the tab change width. An `input` is as wide as its `size` attribute
rather than as wide as its text, so swapping one in resized the tab and shoved
every tab after it along the bar. The tab measures itself as it is pressed and
the field is pinned to that; a name longer than the room scrolls inside it,
which is what a tab of fixed width owes a long name in any case.

The caret and the tab's own lit edge are what say the name is being typed. A
focus ring would draw exactly the border this is removing.
