# 0007. Where the user is, in the URL

*2026-10-06. Cited in the code as §7, "Where the user is, in the URL". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

The open notebook and note were `?folder=<path>&note=<id>`, and every change of either replaced the history entry, so Back and Forward did nothing and the tab said only the app's name.
The owner asked for the title to say where the user is, for Back and Forward to work, and for path-like URLs such as `/#/{NOTEBOOK}/{NOTE}`.
All of it is `apps/web/src/routes/place.ts` and `routes/-home/useOpenPlace.ts`.

- **The hash names the place, a slug for each name**: `#/work-stuff/projects/q3-plan` is the note `q3-plan.md` in `Work Stuff/Projects`, its notebook implied; `#/work-stuff/` is a notebook with nothing open in it, the closing slash telling it from a loose note called `Work Stuff`; `#/` is the loose notes.
  A slug (`urlSlug`) is the name lowercased, with every run of anything that is not a letter, a mark or a digit made one hyphen, so `R&D (2026)` is `r-d-2026` and a note's filename, a slug already, is mostly itself; `.md` is dropped.
  Letters of every script are kept, as filenames keep them (`slugify` in core), which is why this is a few lines and not a library: the slug libraries turn names into ASCII, and drop or guess at most scripts.
  A name with no letter or digit is kept whole, and every slug is `encodeURIComponent`'d, so nothing is rewritten by a browser; a name of letters, digits and spaces needs no escape at all.
  The owner asked for slugs (2026-10-06): the first cut spelled each name exactly, and most names have spaces, which an address bar shows as `%20`.
  Anything else in the fragment — an anchor, a broken escape, a hidden or empty name — names nothing, and the app opens where the user last was.
- **A hash, not a path.**
  The fragment never reaches the server, so the names stay off the wire and out of request logs; `?folder=` sent the notebook's name on every load.
  The server and the service worker still see only `/`, so §8's one-route allowlist and the operator's pages beside the app are untouched, as are the messages other pages leave in the query (`?connect=`, `?code=`, `?enter=code`, `?share=`).
  `/n/Work/plan` was the alternative, and gave up all three for looks.
- **The history entry holds the place by id**, with the source it is a place in (`history.state.place`, `HeldPlace`).
  A slug can be two names, and stops naming a note the moment it is renamed, here or by a pull, and an entry Back comes to can be hours old; the id does not move.
  It also says what the hash cannot: a notebook open above the note's own (§12.6, `noteIsUnder`).
  A reload keeps it.
  The hash follows the note the entry holds, in place, when its path changes.
- **An entry with no place** — a link, a bookmark, an address typed — is read by name once (`findNamedPlace`): the source's notebooks and notes are read, each compared as the hash spells it, and the answer is written into the entry by id.
  Each name in the hash is made a slug again first, so `#/Work Stuff/Q3 plan` typed in reads as the app's own spelling.
  Two names a hash spells alike — `Work Stuff` and `work-stuff` — open the first by path, but a note is looked for in both.
  A note no longer there opens its notebook as a click on it would; a notebook no longer there falls back as one deleted does (`selectedFolderPath`).
  Hidden folders are never matched.
  No notebook is shown while this is read, rather than the remembered one for a moment before the one named.
- **A step is pushed, a correction replaces.**
  Pushed: a notebook or a note clicked, a search answer opened, a note begun with `+`, a notebook made and opened.
  Replaced: what the app works out by itself — the note a notebook opens on, a note begun in an empty one, the place a link resolves to — and what keeps the URL true when something moves under it: a notebook renamed, moved or deleted, the open note moved, an undo, the hash following a rename, and the query's messages taken out once read.
  So a click on a notebook is one step, the note it opens on included, and opening the app is none.
- **A dropdown is a step on a phone (2026-10-08).**
  Reported on Android: Back from a note opened another notebook, as if the end of the swipe had tapped a row.
  It was the notebook open before, which is where Back goes; Chrome shows the entry Back is going to while the swipe is under way, and that entry had been left with the notebooks dropdown open, so the swipe ended over its rows.
  Back went between places only and skipped the dropdowns the user had come through.
  Now the entry holds the dropdown open over its place (`history.state.panel`, `usePanel` in `routes/panel.ts`), and Back retraces them: from a note to the notes it was chosen from, then to the notebooks before them, then to the note before that, and with a dropdown open, Back shuts it.
  The owner chose this over keeping Back for places.
  Opened over a place, a dropdown is a step pushed (`opened`), and shut any other way — Escape, a press outside, its trigger, the open note chosen again — it is Back, so a dropdown opened and shut leaves no step behind.
  One that comes with a place, as a notebook chosen comes with its notes and a source with its notebooks, is in that place's step, and shut, it is taken out of the entry.
  One swapped for another takes its place.
  A correction keeps the entry's dropdown, but not that opening it made the entry once the place is another.
  The scratchpad's wall is not a dropdown but the pane its place rests on (`setRest`).
  A shut that is Back resolves once Back has landed, and what comes after one, a drop's move or a search answer in another source, waits for it: a step pushed before Back lands is the one Back would take.
  A wide window shows no dropdown and opens none; an entry's shows again if the window narrows.
- **The caret stays above a phone's keyboard (2026-10-09).**
  Reported: a tap low in a note, in either editor, put the caret under the keyboard that the tap then raised, and the note had to be scrolled to find it.
  Neither editor scrolls but for a transaction of its own, and the tap's was over before the keyboard rose.
  Now, on a touch screen, when what can be seen gets shorter while an editor has the focus, each box the caret scrolls in is moved just enough to show it two rems above the bottom of the visual viewport (`editor/shared/aboveKeyboard.ts`) — the window itself on Android (`interactive-widget=resizes-content`), the part of a full-height window the keyboard leaves on an iPhone.
  The visual viewport's height is read at the page's scale, so a pinch zoom is not taken for a keyboard.
- **Sources.**
  Each source is its own notebooks and notes (§6), so an entry from one names nothing in another.
  When the source changes under an entry — a tab, a search answer in another source, a connect, another window — the entry is kept and the new source's place pushed after it.
  Back or Forward to another source's entry shows that source again (`showConnection`, device-wide, as a tab is), then the place.
  An entry from a source no longer there, or one in front at start from a source another window has since moved away from, is replaced.
  This replaced `useUrlFromElsewhere`, which emptied the URL on any change of source.
- **The title** is the note's notebooks, outermost first, then its title: `Work > Projects > Q3 plan`.
  A loose note is its title alone; with nothing open it is the brand's name.
  No app name is appended: the tab's icon says which app it is.
- **Left as they were.**
  A connect still returns to `pathname + search` (`returnPath`; `safeReturnTo` drops a fragment anyway), so coming back from a provider opens the place remembered on the device (`store/lastOpen.ts`), as it did for a new source.
  A link from before this change has `folder` and `note` in its query; `parseSearch` refuses both so they are dropped from the URL, and the link opens where the user last was.
  Nothing translates them: no install opens on one, as `start_url` is `/`.
- **Read from the href, not the router's `hash`.**
  TanStack Router decodes `location.hash` except for `%25` and `%5C`, which a name holding `%` would not survive as written, so the fragment is taken from `location.href` exactly as it is.
- **A note on its way says so (2026-10-10).**
  The note the place names is read by id (`useNoteRead` in `store/hooks.ts`), and the answer tells *not read yet* (`undefined`) from *read and not there* (`null`), each matched to the asking it answers rather than to the id alone: a note gone back to while the one between is still being read is not handed its earlier read.
  Until then the pane said "Select a note", as if none were open, which nobody saw while a read took milliseconds; held up behind another tab's write (§7, "A frozen tab lets go of the database"), it said so for minutes over a note just pressed.
  Now the pane is blank, `aria-busy`, and after half a second says "Opening the note…" (`OPENING_NOTICE_MS` in `components/note/opening.ts`).
  A scratchpad card waited for the same read before it opened at all, so a press did nothing.
  Now the card pressed says so on the wall: it is busy, and after the same half second it says "Opening the note…" (`openingId` in `components/scratchpad/useScratchpad.ts`).
  It opens once the read comes.
  It does not open on the wall's copy of the note, because the card grows into its editor (`useCardMotion`).
  Opened on a pane still waiting, it grew into the placeholder, and the editor then replaced it partway through the motion.
  Review found this on every press, not only slow ones, since a live query's first answer always comes a tick after the press.
  Neither the pane nor the card offers an editor before the read: typed into while the store is held up, an edit would look saved and not be.
