# 0005. Pinned to the top

*2026-10-05. Cited in the code as §7, "Pinned to the top". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

A notebook or a note can be **pinned**, from its `⋯` or a right-click on its row: "Pin to top", first in the menu, and "Unpin" once it is.
A pinned row comes first among the rows beside it — a notebook at the top of the notebooks under its own parent, not of the whole tree; a note at the top of its notebook's list — and the pinned keep, among themselves, the order they would otherwise have, as the rest do.
The owner's choices (2026-10-05): remembered on this device, offered in the row's menu, and a pinned row tinted.

- **Tinted, and said in words.**
  A pinned row has a wash of the "on" colour (`--pinned-bg`), lighter than a pressed toggle's, and hover and selection deepen it rather than grey over it, so the row just pinned — usually the one open — shows as pinned.
  A screen reader hears "Pinned" as the row's description (`aria-describedby` on a hidden element), not in its name, which is what the row is found by and announced as.
  Forced colours take the wash away, so there a pinned row has an outline instead.
  The wash is faint on purpose — "a bit of a highlighted color" — and is not the only way a pin is said.
- **Kept per device and per source, in `prefs`** (`store/pins.ts`), as which notebooks are open is, and not synced.
  A provider has nowhere to put it but the note: `pinned: true` in frontmatter would sync, but it would rewrite the user's file and send it up for a choice about how this app lists it, and a sidecar file is what "Re-arranging is moving" refused.
  Two devices may pin differently, as they may open differently.
- **Notebooks by path** (`pinnedNotebooks:<connectionId>`), moved with a notebook renamed or moved and let go of with one deleted, here and by a pull, in the same transactions and by the same code as the open ones (`store/notebookPaths.ts`).
  **Notes by id** (`pinnedNotes:<connectionId>`), which a note keeps through a rename and a move, so nothing has to follow it; a pinned id with no row is let go of the next time a note's pin changes, rather than from every place a note can go, so a note deleted and taken back keeps its pin.
  A notebook there only because something is in it, with no row of its own (as a pull can leave one), goes with nothing to say so; a pinned path that is no longer a notebook is let go of the next time a notebook's pin changes, so one made later at that path does not come up pinned.
  At most 500 of each, oldest pinned first out.
- **Kept with the notes, through connecting and disconnecting (2026-10-25, #452).**
  This used to say they were not carried to another source and stayed behind with the old id, and a source let go of left them in `prefs` for good.
  The owner settled it: "Pins should be remembered when connecting and disconnecting.
  That seems like what a user would expect."
  The same goes for everything this device remembers of a source: which notebooks are open, the note open last, whether the scratchpad and the passwords are shown, and its places in the recent notes (`store/sourcePrefs.ts`).
  - **Disconnecting.**
    A source whose notes all leave the device (Disconnect, a discard, a move, a cancelled first import) has its prefs held for its account (`holdSourcePrefs`, under `account:<provider>:<accountId>`), as the newest, over what that account held already.
    The next time that account is connected, under whatever id the server gives it then, they come back with the bind, or when the account is named after it (`rememberAccount`).
    Its recent notes are not held, since those notes left with it.
    A source whose account the API never named has nothing to come back to, and is forgotten.
    Notes moved into another account's source (`moveUnsyncedTo`) do not take them: they are some of the source's notes, and its pins name its own notebooks, which the other account's of the same name are not.
    A detached source keeps its own prefs while it waits, and a detached source of the account resumed under a new id gives them to it (`carrySourcePrefs`).
  - **Connecting.**
    The device's own notes going into a source take the pile's prefs with them, once the import is done (`finishImport`), or at once where a bind copies them with no import to cancel back to.
    While an import can still be cancelled back to the pile, the pile keeps them.
    An empty pile keeps them too, since they name nothing the source was given.
  - **Merged** wherever two meet (`MERGES`).
    Every pref kept per source is named in `PREF_KEYS`, which is all `sourceKey` takes, and has to say how it merges, so none is missed.
    The receiving source's own come first, except where a source is held for its account, where the source leaving is the newer.
    Lists keep both, up to their limit, the first's last as the newest.
    A notebook pinned to the top in one and to the bottom in the other goes to the end the first had it at.
    The place open last keeps the first's notebook and takes the others' notes.
    A setting stays the first's.
  - **Carried as they were, not followed through `moveRowsTo`.**
    A row usually keeps its path and its id where it goes.
    Where it does not, a carried pin names nothing, and is let go of as above: a notebook re-spelt to the case the source already uses, a name freed for a note that met one, or a conflict copy.
    The one exception is a note given a fresh id because the source already holds a note under its id: the pin then names that note.
  - **Left alone.**
    Prefs an earlier release left behind for a source it forgot, since nothing can tell those rows from a source this device has not loaded.
    Also a pref written back by a tab still showing a source another tab has let go of.
- **The pins come with the tree, from one query** (`usePinnedTree`), so a notebook renamed or moved, or another source shown, is never drawn with the pins from before, and the tree is not drawn in one order and then in another.
  The source is handed in (`useActiveConnectionId`), not asked for in the query, and each read is handed it, so the query has no more reads in a row than the tree had before pins.
  The notes' list is put in order by those pins, not read with them, and `pickNote` is handed them too: either made slower lost a race it wins now — to have a notebook just moved or made before the URL names it (or the app falls back to another notebook and throws the user out of the one they moved), and to have a note's row before it stops being the note begun (or the list is empty for a moment).
  The pins stay the same object while they are the same pins (`pinsKey`), since a note saved re-runs the tree's query and `pickNote` is asked again when the pins change.
  A note begun and not yet stored goes at the top of the ones not pinned.
- **A notebook opened with no note remembered opens its first row**, which is a pinned note where it has one (`pickNote`, handed the pins), so what opens is what is at the top.
- **A search's answers are not reordered**: they are in the order of how well they match, which is what that list is for.
- **A notebook can be pinned to the bottom instead (2026-10-14).**
  The owner asked for "Pin to bottom" on notebooks, working as "Pin to top" does but sending the notebook to the end of the notebooks beside it, under its own parent, on that device.
  The menu has both, first and second, and the end a notebook is pinned to is said as "Unpin" in that end's place, so one pinned to the top goes to the bottom in one choice and the items do not move about under the pointer.
  A notebook is pinned to one end at a time.
  Those pinned to the bottom keep, among themselves, the order they would otherwise have, and a notebook's list follows the sidebar's order (`listedUnder`), so their notes come last too.
  Not tinted: a thin rule above the first of them sets them apart from the rest at their level, from where the names there start to the pane's gutter, and is a border, so forced colours keep it — the owner's choice over the top's tint.
  "Pinned to bottom" is the row's description.
  Kept by the same code in a row of its own (`bottomPinnedNotebooks:<connectionId>`), moved, let go of and limited as the top's are; the top's row is as it was, so a version from before this reads it unchanged and lists a notebook pinned to the bottom as unpinned.
  Notes are not pinned to the bottom: nobody asked, and a note list is newest first, where the bottom is already where the old ones go.
