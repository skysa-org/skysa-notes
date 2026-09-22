---
'@skysa/web': minor
---

Re-arrange notebooks and notes by dragging them. A notebook can be dropped into another or taken out to the top level, and a note can be dragged from the list into any notebook; both are real moves on the provider, through `moveFolder` and `moveNote`. A notebook cannot be dropped inside itself, and a note cannot be dropped at the top level, since the app never makes a loose note. Picking up is also a command ("Move notebook", "Move note to notebook") so the same moves work from the keyboard and from a pointer that never drags, and Escape puts down whatever is being held.
