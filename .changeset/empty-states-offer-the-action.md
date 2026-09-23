---
'@skysa/web': minor
---

Empty panes now offer to do what they suggest. "Select a note, or create one"
makes a note in the open notebook when you press "create one". An empty
notebook says "No notes here yet. Create one." And with no notebooks yet, the
sidebar, the note list and the note pane each have a "Create a notebook" (or
"Create one") that opens the new-notebook field. On a phone this opens the
Notebooks panel as well, since the note pane is the only thing on screen there.

With nothing connected, the `+` in the top bar now reads "+ Connect storage
provider", and the storage panel's hint names it: "Use “Connect storage
provider” above to sync them." Once an account is connected it goes back to a
plain `+`.

If you already have notebooks or notes on this device, choosing a provider now
asks first: "Your 2 notebooks and 5 notes on this device will move into Dropbox
and sync there." **Connect and move** carries on as before. **Cancel**
(which has the focus, and is what Escape does) leaves everything on this device
only, with nothing written and nothing sent to the server.

**Connect and move** is filled in the accent colour, as the answer the
question expects. Cancel still has the focus.

Deleting a notebook now asks in the same kind of dialog, over the page,
instead of in a strip under the Notebooks header: "Delete notebook? “Work” and
the 3 notes in it will be deleted." Cancel has the focus, Escape cancels, and
keyboard shortcuts wait until you've answered.

Right-click a notebook in the sidebar, or a note in the list, for the same
menu its `⋮` button opens: New notebook inside, Rename, Move and Delete for a
notebook; Move to notebook and Delete for a note. It acts on the one you
clicked, which does not have to be the one open, and deleting a note this way
offers Undo just as the note's own menu does. The menu key and Shift+F10 open
it too, under the focused row.

The `⋮` menus now open over everything and stay inside the window. At
widths just above the phone layout the notebook menu used to run off the left
edge of the window, and then was cut off at the edge of the sidebar.

The note and notebook options menus are now drawn like the
"Connect storage provider" menu and the editor toolbar's menus: a card with a
full-width row per choice that lights up under the pointer. They used to be a
list of underlined links.
Their buttons show three solid vertical dots, like Material's "more" icon: the
same icon in both, centred in the button, and the same one the formatting
toolbar's overflow button uses. The dots are twice the size they were, which
was hard to see. The notebook's button used to be a `⋯` character sitting low
and to one side, in a boxed button; it is now drawn like the note's, with no
box, and lights up under the pointer.

The Markdown tab in the note's header now shows a code icon (`<>`), which is
easier to tell apart from the rich text tab next to it.
