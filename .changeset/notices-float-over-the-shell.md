---
'@skysa/web': patch
---

The notice after connecting a storage account, and the one saying why a note or
a notebook could not be made, are now cards floated over the page with a
Dismiss button, rather than a thin grey bar across the top of the frame.

The bar was missable, which was found the way these things are: an account was
connected with Google's files permission unticked, the app said so correctly,
and the line was read only after being looked for. `role` still follows the
message — `status` for "storage connected", `alert` for everything that did not
work — so what a screen reader does is unchanged.

There is no timer. Every message here either asks for something to be done
again or names a note to go and find, and one that disappears mid-sentence is
the fault being fixed rather than the fix; they go when dismissed, or when the
user does anything else, which was already true. That also leaves no time limit
for WCAG 2.2.1 to be about.

The undo-delete notice joins them in one stack instead of placing itself 5rem
up to dodge the new-version prompt. Two notices at once — a failed create while
a connection message is still up — now sit above one another rather than on one
another. The card styling the four of them share is one rule; only the placing
differs.
