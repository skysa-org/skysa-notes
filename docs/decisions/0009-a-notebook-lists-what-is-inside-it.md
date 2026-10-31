# 0009. A notebook lists what is inside it

*2026-10-07. Cited in the code as §7, "A notebook lists what is inside it". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

A notebook's list shows its own notes, then the notes of every notebook inside it, at any depth.
Each inner notebook's notes come together under its path from the open one (`Projects/Q3` under `Work`).
The groups follow the sidebar's order for the notebooks: the pinned first at each level and those pinned to the bottom last, and each before the ones inside it (`listedUnder` in `store/tree.ts`).
The owner asked for it (2026-10-07), with the notebook's row counting all of them open or shut, to match.

- **Its own first.**
  They are the ones `+` adds to and the ones the notebook opens on: `pickNote` still picks from the notebook's own notes, and a notebook with none of its own begins a note as an empty one does, whatever is inside it.
  Pinned notes come first within their own notebook's group, not at the top of the whole list, since a pin lifts a row among the rows beside it.
- **A note chosen from inside opens its notebook**, with the note, as a search result does: the sidebar then lights the notebook the note is in, and the list is that notebook's.
  A note under the open notebook can still be open without its notebook being chosen — the one already open when a notebook above it is clicked (`noteIsUnder`) — and it is now in the list, where before it was nowhere.
- **The loose notes are not a notebook**, and list only what sits at the root (§12.6).
- **The tree and the notes are separate queries**, so a note in a notebook the tree does not have yet — one a move or a pull has just made — goes at the end, by path, until the tree catches up, rather than nowhere.
- **A row is drawn again only when what it shows changes (2026-10-07, #275).**
  The page draws the list on every autosave, sync run and keystroke in the search field, and a notebook of a thousand notes was a thousand rows drawn again each time, for one note saved.
  A row is memoized (`NoteRow`), and handed values and handlers that stay the same: the page's own handlers are new on each of its draws, so the list hands its rows ones that call whichever the page gave last.
  A query hands back new objects every time it runs, so a note unchanged since the read before is handed back as the object it was then (`keptRows`), compared field by field.
  A row's menu is made when it is opened, and the notes are grouped by notebook in one pass (`byParent`).
