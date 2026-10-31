# 0010. The scratchpad

*2026-10-07. Cited in the code as §7, "The scratchpad". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**Quick notes on a wall of cards.**
It is there for every source, the device's own notes included, until it is hidden — per device and per source, from the storage menu ("Hide scratchpad", on the gear and the source's `⋯`) — and shown again from there ("Show scratchpad"), which opens it.
Its row sits above the notebooks' heading, as tall as the headings at the top of the other columns so the rules under them line up, and choosing it puts the scratchpad in place of the note list and the editor: a box to take a note in, then the cards, the pinned first under "Pinned" and the rest under "Others" (each label shown only beside the other).
The scratchpad has no heading of its own; the row, lit, says where the user is — in a wide window, as the bar does in a compact one.
A phone slides to it as it does to a notebook's notes, and the bar says "Scratchpad" with no note dropdown after it.
There, the scratchpad is all there is under the bar while no card is open, so shutting the notebooks or the sources over it — by their trigger, Escape or a press outside — goes back to it, as does choosing its row again (`usePanel`'s resting pane), rather than to an empty window.
The owner asked for it on 2026-10-07 and chose the answers below.

- **Ordinary notes in a folder of their own** (§3).
  The sync engine, conflict copies, the unsent count, export, attachments beside a note and the move of the device's own notes into a first source all work on them unchanged, which is the reason for this over a table of their own.
  The folder is no notebook: the tree, the notebook counts and the notes' list leave it and its notes out (`usePinnedTree`, `useListedNotes`).
- **Whether it is shown is the device's** (`prefs`, `scratchpad:<connectionId>`, `store/scratchpad.ts`), as the clipboard is, but in `prefs` rather than on `syncState`: the device's own notes have a scratchpad too, and no `syncState` row.
  Hidden, its notes stay where they are and keep syncing.
- **Shown unless hidden, and a new source as the last was left** (the owner's choice, 2026-10-07).
  A source never shown or hidden on this device shows it as the user last chose for any source (`scratchpadNewSources`), and shows it where they never have: hidden on the device's own notes, it is hidden on a source connected next.
  That choice is for sources to come, not the ones there now: each source on the device that was never shown or hidden itself is held at what it shows (`setScratchpadShown`, one transaction) before the choice changes, or hiding the device's own scratchpad would hide one beside it.
- **Pin and colour are in the file** (`pinned: true`, `color: <name>`; §3), so they reach every device.
  The owner's choice, and the opposite of "Pinned to the top", which keeps a notebook's pins on the device: there, a pin is how one device lists a library, and writing it into the user's file was the cost refused; here, a card's pin and colour are what the card is, wherever it is opened.
  A change to either is a user edit (`setScratchMarks`), and a note stored for it first if it was a draft.
- **A card** shows the note's name if it has one, and its first 60 or so words (`cardLines`), in no more than 12 lines, lines kept as lines and "…" where it was cut.
  They are set as the note sets them (`previewBlocks`, §7, "An empty line is a blank line"): bold, italic, struck, code and a link's words as they are in the text — a link that goes to the web, an e-mail address or a phone number opens in the browser when its words are pressed (2026-10-12, §7, "Links open in the browser"); a heading heavier; a quote ruled off; an item's bullet, number or box before its words, a task done struck through — the marks drawn by the card and kept out of its name, not printed as the characters that wrote them.
  A picture is drawn where it is, whole, no taller than six of the card's lines and counted as six of its twelve, and a file as the editor's chip (`CardEmbed`, the owner's ask): got as the editor gets a picture (`useNoteAttachments`, one host to a card with a picture in it), once it is on screen and never a large one, and said in its words until it is.
  It is drawn from the thumb, a copy no larger than a card ever draws it (§7, "Drawn from a copy"; 2026-10-08, #276).
  Its room is held from the card's first drawing, with its words in it meanwhile, so a card is placed at the height it will have and the wall does not place it again when a picture arrives (`Room` in `CardEmbed.tsx`).
  Where this device has read the picture's size before (`AttachmentHost.size`, asked as soon as the card is drawn, seen or not; remembered for the session, so a card drawn again has it from its first frame), the room is the size it is drawn at.
  Otherwise it is the tallest a card draws a picture, 8rem, with the picture drawn inside it, at its own size or smaller, for as long as the card is drawn.
  A size said only as the picture arrives is not taken: copies are made one at a time, so on a wall seen for the first time the pictures arrive one by one, and each would place the wall again.
  A landscape photo on a phone's narrow card is shorter than 8rem, so there is a little room under it until the card is next drawn.
  A picture that is not coming gives the room back for its words.
  One from the web, or an SVG, comes as it comes.
  It shows what is being typed as it is typed.
  A press anywhere on it opens it, its foot too, but for its tools and its links: the open button's press is stretched over the whole card, and the row of tools lets a press between them through.
  Its pin, colour and `⋯` (move to a notebook, delete) show on hover and focus, and always on a touch screen; the colour and `⋯` are lit while their menu is open, as a toolbar button is, and keep the row shown while the pointer is on it.
  A coloured card has the clipboard's glow in its colour: a gradient of it, an edge drawn inside, a glow outside.
  The cards are placed in columns of at most 240px, two at the least, each in turn under the shortest column (`components/scratchpad/masonry.ts`): CSS columns would fill one column top to bottom, putting the second newest card a screen away from the newest.
  The document's order is the cards' order, so reading and Tab go pinned first, then newest first.
- **Taking a note.**
  "Take a note…" is one line until pressed; then it is the note editor, with the body taking the focus, a "Title" field above it, and under it one row: the basic toolbar (bold, italic, the three lists, the paperclip, link; no slash menu), then the note's colour, its `⋯` and Close, ruled off from the tools (`RichEditor`'s `toolbarEnd`).
  The toolbar has what that bar leaves of the row, and on a phone puts what does not fit behind its More tools.
  In Markdown, which has no toolbar, the bar is under the note.
  A file attached goes beside the note in `.scratchpad/`, as beside any note (§3), and goes with it when it is made a note (`carryLinkedFiles`); the paperclip was left off at first, and the owner asked for it (2026-10-07).
  It is a draft until the first edit, as a note begun anywhere is.
  The box eases between the two heights rather than jumping (`useEasedHeight`), to where what is in it comes to as the editor is drawn.
  Close, Escape or a press outside the box puts it down, and one stored and left with nothing in it — no text, no name, no pin, no colour — is deleted quietly.
  Escape is taken from inside the text even though ProseMirror claims every Escape there (its base keymap selects the block around the cursor), since in a note's text Escape is the user leaving it; a panel of the toolbar claims its own Escape first.
- **A card open** is the editor with the same tools, in a dialog over the scratchpad on a wide screen (the app behind it `inert`; Escape or a press beside it closes it), and the whole window on a phone, where the bar says "Scratchpad" and then the note's name — or, for one with none, its first words, and nothing for one with neither (2026-10-13, `shownName`) — as words, not a dropdown: Back or Close is the way out of a card.
  Opening a card is a pushed step, so Back closes it (§7, "Where the user is"): `#scratchpad`, and `#scratchpad/<slug>` for a card, outside `#/…` so no notebook can be spelled the same.
  The title is "Scratchpad", or "Scratchpad > <name>".
  **One `NoteView` is ever mounted**, placed by the route where it is wanted — the third column, the box, the dialog, or the compact window's note pane — so the editor's commands, autosave, drafts and delete-with-undo each still have one owner.
- **A card grows into its editor, and goes back into it** (`components/scratchpad/cardMotion.ts`): the dialog, or the phone's whole window, is drawn from the card's box to its own, and closing sends it back into the card wherever the card is by then — the owner's ask.
  In the Web Animations API, since only a measurement knows where the card is, timed and eased by the stylesheet's tokens, so it does not move at all when less motion is asked for.
  Three things each found wanting in the browser first:
  - *Words keep their shape.*
    A box going from a card's shape to a phone's window is scaled far more one way than the other, and the words in it with it.
    So each child is drawn at the inverse of the box's scale, about the box's corner (`unstretch`, in steps), keeping its size and its place, and the box's edge cuts off what is past it: it shows more as it grows.
  - *A copy of the card goes the same way, over it*, its words going before the editor's come, and back again on closing, the card itself held until both copies are on it.
    Fading the editor alone left a moment near the end with neither, which read as the card blinking out; and two sets of words, each laid out as it is, read over each other while both were there.
  - *Closing animates a copy.*
    By the time the place has changed, the editor is gone, by Close, Escape or Back alike; what goes back is a clone, taken as it is let go, inert and hidden from a screen reader, and removed once in.
    On a phone the shell says a card is open (`data-card`) and that the scratchpad is all there is (`data-wall`), so the wall shows at once under the closing copy rather than sliding in as a panel, and stays in sight under the growing one until it has grown.
    The editor has a background of its own, since a note with no colour was see-through over the wall as it moved.
  - *Not under a dropdown (2026-10-10).*
    A card open on a phone under a dropdown, shown again by Back or Forward, or left by a place chosen there, comes and goes under it with no motion (`unseen`, `CardSheet`): the copies are drawn over the panels, so it grew over the notebooks sliding in, or faded out over the notes sliding past — sometimes, as the growth needs the wall's cards read.
    What is in sight as it goes is what it was when last drawn.
- **A card is drawn again only when what it shows changes (2026-10-07, #275)**, as a note list's row is (§7, "A notebook lists what is inside it"): memoized, its place handed to it as numbers, the scratchpad's handlers through ones that stay the same, and a card unchanged since the read before the object it was then (`keptRows`, in `useScratchNotes`).
  The wall is placed in one pass (`placeCards`), each column's foot written to as each card goes on.
- **Search finds scratch notes**, said to be in "Scratchpad", and opening one opens its card; the owner's choice.
  Only while that source's scratchpad is shown, since that is the only place one can be opened.
- **Made a note** ("Move to notebook"): a card with no name is asked for one first (`NameDialog`), then it is picked up as a note moved from its list is, and dropped on a notebook.
  Its pin and colour are taken off as it goes (`moveNote`), and the app opens it there; the owner's choice.
  Cancel leaves it on the wall, named.
