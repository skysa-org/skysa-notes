# 0004. The sidebar opens as far as it is asked

*2026-10-05. Cited in the code as §7, "The sidebar opens as far as it is asked". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

A notebook with notebooks inside it lists them only while it is **open**, and a notebook starts **shut**: a library brought in from elsewhere can be hundreds of notebooks nested three deep, and listed whole the sidebar was a column to scroll to find anything in.
The owner's choices (2026-10-05): shut by default, remembered per device and per source, Left and Right on a row, and counts that include what a shut notebook hides.

- **What is kept is which are open**, in `prefs` (`store/openNotebooks.ts`, `openNotebooks:<connectionId>`), as `lastOpen` keeps where the user was and for its reasons: how far one device has the tree open is that device's, and each source is its own notebooks.
  Kept as open rather than shut, so a notebook nobody has opened — pulled, imported, made on another device — is shut wherever it came from.
  At most 500, oldest opened first out, since one let go of is shut, which is where it starts anyway.
- **By path, and so moved with the notebook**: `moveFolder` rebases the open ones it moves, a rename included, and `deleteFolder` lets go of the ones it deletes, each inside the transaction that changes the paths (it already holds `prefs`).
  The sync store's `moveFolder` and `deleteFolder` do the same, so a notebook another device renamed is still open here under its new name.
  A notebook made later at a deleted one's path starts shut, as a new one does.
- **The open notebook is always reachable**: when a notebook is opened in the note list — from the URL, from where the user was, from a search or a palette command, or made — the notebooks it is in are opened, once for each opening, so shutting one of them afterwards is the user's to do and stays done.
  Switching source and back counts as an opening, since the row has to be found in a tree just drawn again.
  The palette's **Rename notebook** opens the notebooks the open one is in first, so its row is there to type the name into.
- **A chevron before the name** opens and shuts it, drawn over the row's start as the `⋯` is over its end, so the row keeps its whole width for its highlight, its hit area and its drop outline.
  It is out of the tab order: the row is the stop, and **Right** on it opens a shut notebook and goes into an open one, **Left** shuts an open one and goes out of any other, to the notebook it is in, as in any tree of folders.
  With a modifier held the keys are left to the browser and the screen reader.
  The chevron is still a button with a name ("Notebooks inside “Work”") and `aria-expanded`, for a screen reader's list of them and for a pointer, and the row carries the same `aria-expanded`, since the row is where focus is.
  On a coarse pointer the chevron's button reaches back over the gutter, where there is nothing else to tap, and is 1.75rem or more wide: a thumb's width rather than an icon's, while the names move over by only 1rem.
- **A move reaches inside a shut notebook**, since a destination there has to be reached without first cancelling the move to open it.
  While something is being moved, the chevron is a tab stop of its own and a drop target that drops on its row.
  Resting a dragged note or notebook on a shut notebook for 0.6 s opens it, as a spring-loaded folder does.
  That works on a notebook that cannot be the destination too, such as the one the note is already in: a disabled row passes the pointer through (`pointer-events: none`) to its item, which is what watches for the rest.
  The rest is timed from the `dragover` events the browser sends while the pointer stays put, with no timer of its own to clear.
- **A notebook counts every note inside it**, at every depth, open or shut (2026-10-07).
  Until then an open one counted only its own, since the ones inside showed theirs beneath it; but its list now shows them all (§7, "A notebook lists what is inside it"), and a number that changed as the chevron turned said nothing new about the notebook.
- **Room for a chevron is set aside only in a tree that has one** (`.tree.nested`, `--disclosure`), so the names stand in one column; a library with nothing nested looks as it did.
- **The chevron's stroke starts at the gutter**, where the text of every other list and of the pane's heading starts, not its drawing's box: the drawing has blank space before the stroke, so the box starts that far into the gutter.
  It turns about its middle as it opens, so it keeps its distance from the name, and open, being wider than tall, it reaches 2px into the gutter.
  The room after it is one level of nesting (0.85rem), so a notebook's chevron is under the name of the notebook it is in.
- **A row is drawn again only when something about it changes (2026-10-07, #275)**, as a note list's row is (§7, "A notebook lists what is inside it").
  The tree is built again on every autosave and sync run, so a notebook that has not changed, nor anything inside it, is handed back as the node it was (`keptTree`), and the tree as it was where nothing changed; it is built in one pass, each notebook put under its parent once (`buildFolderTree`).
  Each row is memoized (`FolderItem`), and told of the notebook selected, the one under a drag and the one being renamed only where that is the row or one inside it, so a selection, or a drag from one row to the next, redraws the rows above the two it was and is; only an open row is handed which notebooks are open, so opening or shutting one redraws the open rows and no shut one.
  A row's count is kept by node, and its menu made when it is opened.
