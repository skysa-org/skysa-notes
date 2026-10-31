# 0012. Large libraries

*2026-10-08, #275. Cited in the code as §7, "Large libraries". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

A phone holds a notebook of a thousand notes.
A list that draws a thousand rows has a thousand rows to lay out, style and keep in memory, on a CPU a quarter as fast as a laptop's.
So a long list draws only what is near the screen (`components/ui/windowing.ts`).

- **Above 150 rows**, the note list draws the rows that meet the screen and a screen above and below it.
  In place of the others is an empty item as tall as they are, so the list is as tall as it would be and the scroll bar the same.
  A notebook inside the open one that is wholly off screen, its name too, is one empty block.
  A list of 150 or fewer is drawn whole, as it always was.
- **Heights are measured** where a row has been drawn (`useHeights`, one `ResizeObserver` for the list, as the scratch wall measures its cards), and taken to be the mean of those where it has not.
  A row is a line each of title, date and opening, so the guess is near enough that nothing is seen to move as rows are measured.
  A height of 0 is not taken: it is what every row of a hidden list measures (a phone's list behind the open note), and taken, it would put every row at the top, where all of them meet the screen.
- **Drawn again a few times a screen**, not every frame.
  The span drawn is said again only once the screen has moved a quarter of its height (`useScrollSpan`), and a screen beyond it is always drawn.
  It is read again as well when anything between the scroller and the list changes size: the scratchpad's take-note box, closing, moves the walls under it with no scroll.
  Then only the rows new to the span are drawn: what a row is told (its height's ref, its place, the focus handlers) stays the same, so a row already drawn is not drawn again.
- **What the user is at is drawn wherever it is:**
  - the selected row;
  - the row the focus is in, or in its menu (a portal, whose focus React brings up through the row), and the rows either side of it, so Tab and Shift+Tab land on a row and the browser brings the list to it.
    The focus is let go of only once it has landed elsewhere: a move within the row, or into its menu, is a blur and then a focus, and React draws the blur before the focus arrives.
    Nor when the window loses the focus and the row keeps it (another app, the address bar): the browser gives it back to the same element on return;
  - the row being dragged, so a drag's source never leaves the page under it.

  A right-click menu closes when anything scrolls.
  A row says where it is among all of its notebook's (`aria-setsize`, `aria-posinset`), so a screen reader counts the rows not drawn.
- **Before the list can be measured** it draws its first two screens (the window's height), not every row: drawn whole, the first draw would be the slow one.
- **Where nothing is laid out**, as in a test, there is no screen to be near, and everything is drawn, so every test of the list as it was still holds.
- **The scratchpad, above 100 cards,** draws the cards placed near the screen, by the same span.
  The wall keeps the height of all of them, so its scroll bar is as it was — once they are placed: on a first look it grows as the guesses below arrive.
  - A card is placed by its height as drawn (`useHeights`) or, until it has been, as guessed from its text (`guessHeight`, read from the caches under "It is a parse").
    In a column of cards one under another, each card's place is the sum of those above it, and the shortest column takes the next card, so one card measured late moves every card after it, and can move them into other columns.
    Measured only as it was scrolled to, a card above the screen moved the cards on it: after any jump (the scroll bar, End, the focus going back to a card far down), every quarter screen scrolled up moved them again.
    The note list has no such trouble, as its rows are in the flow and the browser's scroll anchoring holds them; the cards are placed by `transform`, which it does not.
  - So **every card is measured ahead of the screen**, eight at a time while the page has nothing else to do (`whenIdle`: `requestIdleCallback`, or a timer where Safari has none), from the top down: drawn where it is placed, measured, and let go of.
    A few seconds after the scratchpad is opened, each card is placed by its own height and stays there.
    It costs what drawing every card once did, but after the scratchpad is shown, not before it.
    It starts only once a card has been measured on either wall (the rest can lie wholly under pinned cards that fill the screen), so cards that cannot be measured, as in a test, are not drawn for it.
  - **The guesses are worked out a slice at a time (2026-10-08), from the top down,** 8 ms each (`SLICE_MS`), with the thread handed back between them (`handBack`).
    The wall is placed as far as they have gone: a card's place hangs on every card above it, so a card not guessed yet is neither placed nor drawn, and nor is any card after it.
    A guess reads the card's text.
    On a first look at 600 cards, every one was read in the task that drew the scratchpad: 381 ms on an emulated phone.
    That task is now 214 ms, mostly each card's frontmatter read to tell the pinned cards from the others (no longer, below), and the first cards drawn; the cards show a third sooner (492 → 331 ms).
    The first slice is drawn with the wall, and the wall grows as the rest arrive, in about the time the one task took.
    A guess is kept with its note object (`guessed`, a `WeakMap`), so while the scratchpad stays open a card is guessed again only once it changes or the cards change width; left and opened again, every card is a new object and guessed again, from texts already parsed.
    Only a first look waits for slices: cards arriving above cards that have a height already (a sync's, or the scratchpad at a new width) are guessed in the task that brings them, as before, since a wall that ended at the first of them let go of every card after it, the one the focus was in among them.
    Each slice guesses at least one card, so a coarse clock cannot hold the wall still, and each wall has a slice of its own, so with pinned cards a task can spend two.
  - **Which cards are pinned is read only from the blocks that say `pinned` (2026-10-08).**
    The wall puts the pinned cards first (`scratchGroups`), and asks it of every card on every read; each card's frontmatter was read as YAML to answer, 600 parses on a first look at 600 cards.
    Only a block with the word in it can pin its card, since the app writes `pinned: true` and takes the key out to unpin, so the rest are not read; short of a key spelled with escapes inside quotes, which nothing writes, the answer is the one a parse gives.
    On an emulated phone, 600 cards with 60 pinned, the first cards came 23% sooner (334 → 259 ms), and the longest task went from 214 to 147 ms.
    An index of the pinned cards was weighed (the owner's question) and not built.
    It would read nothing less, since the wall reads every card to place them; the blocks still read are the pinned cards', which drawing them reads anyway for their colour; a stand-in for it, a flag read with no parse, measured the same as this; and it would have been a field kept right on every write and a new database version to fill it.
  - Heights measured at another card width (a phone turned, a window narrowed) are measured again the same way (`useHeights({ stamped: true })` says when each card was last measured), and a card that is drawn already is left to its own measuring, so one that is never measured again cannot hold up the cards after it.
  - Always drawn, once placed: the open card; the card open last, which closing grows the editor back into and gives the focus back to (`useCardMotion`, `useFocusBack`); and the card the focus is in, or in one of its menus, with the cards either side of it in the order Tab takes, the pinned and then the rest (`useFocusedItem`, `besideOf`, as the list's rows).
    The wall follows the focus at any number of cards, so a sync that takes it past 100 keeps the card the focus is in; the list follows it only while windowed, and a row the focus is in, far down a list a sync takes past 150, is let go of.
  - Before the wall has a width to place cards by, it draws its first 40, not every one.
- **Search** is ready, or nearly, by the first letter.
  Indexing 3,600 notes took about a second on an emulated phone, all of it in the task the first letter waited on, and every letter after it waited a fifth of a second more for fifty excerpts.
  Now:
  - the index is begun as the field takes the cursor, and built 8 ms at a time (`SLICE_MS` in `store/slices.ts`), the thread handed back between slices by a message rather than a timer, which browsers hold back to 4 ms once timeouts nest.
    A refresh begun while another is going takes over from it, and one for a search that has ended stops;
  - the notes are read for it 250 at a time, in one transaction (`listNotesEverywhere`): one read of every note is handed over in one piece, a tenth of a second on that phone;
  - the answers follow the field a step behind (`useDeferredValue` in `NoteSearchField`), and the first are drawn as a transition, so a letter typed goes in before them.
    A match's excerpt is made as its row is drawn, so it is work that draw can stop between;
  - the query is held under the page (`SearchQuery`), so a letter draws the bar and the field, and not the sidebar, the list and the note.

  On that phone a key in the search takes 16 ms at the 95th percentile, where it took 192, and no task runs over 50 ms.
- **Bringing a library in** — an import, or a first pull — reads every note's file (`parseNoteFile`) before the transaction that writes them, 8 ms at a time (`eachInSlices` in `store/slices.ts`), and hands what it read to `noteRecordFromFile`.
  Reading is most of what a note costs to bring in: it works out the note's title, which until 2026-10-08 meant parsing the whole body (now only as far as its first heading; see the end of this section).
  An import read every note twice inside its transaction, as one synchronous piece: on an emulated phone, 3,600 notes held the page still for twelve seconds.
  Now the longest task is 143 ms, and the import takes 8.3 s where it took 13.7.
  A pull read its notes one by one in its transaction, between writes, so the page went on answering, but nothing else could read the notes until all of them were in: for 3,000 notes in a test, the transaction is open for 0.75 s where it was open for 4.
  An imported note numbered because its name is taken is read again in the transaction, by its new name, only where its title may be its old name's — no frontmatter title and no heading that differs from it — since a name titles a note with nothing else to: an archive imported a second time, every name taken, is not read again in it note by note.
  Whether a pulled file brings the body a row already has compares it with the body of the row's own file, split from its frontmatter (`splitFrontmatter`) with no title worked out.
- **A sync run that brings nothing reads none of the showing source's notes.**
  Each run writes to its source's `syncState` row — when it ran, and the cursor it got to — once a minute, and the tree, the note list and the loose count each asked inside their query which source was showing (`activeConnectionId`), which reads that row.
  So every run read every note in the source again, built the tree and sorted the list, for nothing that had changed: with 3,600 notes, as much work as a note saved.
  The source is asked by a query of its own (`useActiveConnectionId`), whose answer is the same string after a run, and handed to the three (`usePinnedTree`, `useNotesUnderFolder`, `useLooseNoteCount`), as it already was to the scratchpad, the place remembered and the note to open.
  Each answer carries the source it was read for, and one read for another is not handed back: on a change of source the tree is not drawn, or a notebook opened from it, under the source shown after it.
  `tests/routes.idleSync.test.tsx` holds a run to no notes read.
  Nor any of a detached source's (2026-10-08): `connectedSources` lists the sources from every `syncState` row, so any run re-runs it, and it counted what each detached source never sent from all of that source's notes — once a run for each list mounted, up to four, for a count nothing showed: the detached source's panel counts its own (`unsyncedIn`), and the lists ask only whether a source is detached, which is all they are now told.
- **The cost: the browser's find-in-page sees only the rows and cards drawn.**
  The app's own search sees every note.
