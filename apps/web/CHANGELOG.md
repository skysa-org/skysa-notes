# @skysa/web

## 0.2.0

### Minor Changes

- 99ed655: Disconnecting a source now asks what should become of anything it never sent,
  before anything happens — and can move it to another connected source.
  
  Pressing Disconnect saves whatever the editor is still holding, sends one last
  push where that has any chance of working, and then asks. That push is the app
  finishing what you had already asked it to do, and it is the only thing that
  happens before you answer: nothing is said to our server until then, so
  cancelling leaves the account connected exactly as it was. If the account has
  everything, it is the plain confirm it always was. If it does not, the question
  says how much has not reached it and cannot once it is disconnected, names the
  notes (five, with the rest behind "and N more") and counts the renames, deletes
  and notebooks, and says why they cannot be sent right now when you are offline
  or a change has been refused too many times. Cancel is the button that has the
  focus in every step, Escape closes, and a note whose text could not be saved
  yet stops the question being answered at all until you have copied it out.
  
  The answers are to move it, download it, discard it by name, or cancel.
  **Move** takes the notes the account never had in full, and the notebooks they
  are in, into another source you have connected — named on the button, chosen
  from a list where you have more than one — and uploads them there as new
  notes. A second step says what will be in each account afterwards: a note the
  old account already had in an older version stays there as well, and a rename
  or a delete you made but never sent is not carried across, because each is
  about a file only the old account has. That same Move is now on a disconnected
  source's own panel, beside Reconnect, Download and Discard.
  
  Move is offered only where it means something: there has to be another source
  connected, something of the kind it carries on the list, and the source's files
  have to have been checked against its account. A source you reconnected and
  have not been online with since lists everything it holds, because until those
  files have been looked for, "already sent" is a memory rather than a fact — so
  the question says that is why the list is full, and offers Download, Discard
  and Cancel but not Move.
  
  As with Discard, a move reaches only what you were shown: a note written into
  after the list appeared is kept where it is, and the source stays on the device
  around it. So is a note whose save is still failing when you answer, even if it
  only began failing while you were reading the question. Undoing a delete after
  a move puts the note back in the source its notes were moved to — under a new
  id where that account already had one of its own by that name, so nothing of
  its is written over — and an editor left open on a moved note follows it there.
- ebd106f: Disconnecting a source no longer leaves its notes in a pile on the device that
  nothing shows while another source is connected.
  
  A disconnect now removes from the device the notes the storage account already
  has — nothing is deleted from the account, and connecting it again brings them
  back. Whatever the account was never sent (an unsent note, a rename, a delete,
  a new notebook) stays exactly where it was, under that source, which is marked
  disconnected in the list with a count of what it holds. This is the same
  whether you pressed Disconnect, stopped syncing on this device, or the account
  was disconnected from another device while nobody was there to ask.
  
  Text you were typing when the disconnect happened is kept too: what an editor
  still held is saved first, and a save that arrives after its note went with the
  source puts the note back under that source as an unsent change.
  
  A disconnected source can still be opened and edited, with a notice saying it
  is not syncing. Its panel offers three things: Reconnect, which takes the kept
  changes up again when it is the same account (a note the account has changed
  meanwhile is kept beside it as a conflict copy); Download, which saves the
  unsent notes as a ZIP of markdown files; and Discard, which lists the notes by
  title, says plainly when a delete would be carried out on reconnecting, asks
  twice, and can only discard what it listed as it stood — a note written after
  the list was shown, or written into since, is kept, and so is everything if
  the source was connected again from another tab meanwhile.
  
  Connecting a different account never takes another source's notes, and the
  "these notes belong to another account" prompt is gone with the pile it was
  about. Undoing a delete after its source was disconnected puts the note back
  under that source and says so.
- 167f604: Empty panes now offer to do what they suggest. "Select a note, or create one"
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
- 480405f: A source's first import says how it is going — notes found, then downloaded and uploaded against the whole count, with the file it is on — and can be cancelled, which puts the device back as it was before connecting. For the first source connected, the app is held behind the progress dialog until the import is through. The sync engine takes an `onProgress` option, and a full scan now lists every page before it downloads a note, so it has the whole count first. The web app cancels a sync session's requests when the session ends.
  
  The page and the installed app are called Skysa Notes. The storage panel's Re-scan and Disconnect are outlined buttons, Disconnect in red. The outline's toggle sits beside the note's menu, and on a phone the outline flies out over the note and shuts once a heading is chosen.
- 8c1fd73: Notebooks can be managed. The `+` in the sidebar header now makes a **top-level** notebook whatever is open — before, it always nested under the open notebook, so once there was one there was no way to make another at the top level. Beside it is a menu for the open notebook: a new notebook inside it, Rename, Move, Delete. Renaming happens in the row itself; deleting asks first and says how many notes would go with it, counting those in notebooks inside it.
- 8bb745f: Notes are keyed by connection and id, so two connected sources can each hold a
  note of the same id — which they do whenever one folder has been copied into
  two accounts, since the id travels in the file.
  
  The local database moves to schema version 5 on first open. Every note is
  carried over as it was; the upgrade is a single transaction, so a failure
  leaves the database as it found it. A tab still running the previous build is
  stopped and asks to be reloaded.
  
  A file whose id another source already holds now syncs under the id it names.
  It used to be given a made-up id, and the two sources then took turns writing
  their own id into the file.
  
  `SyncStore.idHeldElsewhere` is removed from the core port: a store's ids are
  its connection's own, and the engine no longer asks. When two sources that
  held a note of one id are both disconnected, the second to arrive in the local
  pile is given a fresh id and keeps its queue.
- 8c1fd73: Re-arrange notebooks and notes by dragging them. A notebook can be dropped into another or taken out to the top level, and a note can be dragged from the list into any notebook; both are real moves on the provider, through `moveFolder` and `moveNote`. A notebook cannot be dropped inside itself, and a note cannot be dropped at the top level, since the app never makes a loose note. Picking up is also a command ("Move notebook", "Move note to notebook") so the same moves work from the keyboard and from a pointer that never drags, and Escape puts down whatever is being held.
- 512fff3: The layout follows the width of the window, and each part of it the room it
  has. Below 1250px the notebook and note columns narrow with the window. In a
  window as narrow as a phone, the source tabs become a dropdown, the notebooks
  and the notes become dropdowns beside it, the search becomes an icon — or a
  field, on a bar with the room — and the source dropdown holds the storage
  panel — what is syncing and the way to disconnect — above the way to connect
  another account. The formatting toolbar is hidden there until the Format
  button shows it at the bottom of the note. The outline starts open beside a
  wide note and collapsed beside a narrower one, with an Outline button in the
  note's header to open it, going by the note's own width rather than the
  window's. The note's header keeps to one line, the path giving way before the
  title, and its controls are icons: rich text and markdown as a pair of tabs,
  Outline and Format toggles that show when they are on, and a Note options
  menu to move or delete the note. Spacing is consistent across the screen —
  the note's title lines up with its first line and the toolbar's first
  label, pane headings with their rows — and tightens in a compact window. A
  toggle that is on shows it in the accent colour, and no longer looks on
  after being tapped off on a touch screen. The formatting toolbar keeps to one line too: what does not fit moves
  into a More tools menu at its end, least used first. While a notebook or note is being moved, the hint above the notebooks has a
  Cancel link, and Escape still works. Pressing Escape on the
  `+` beside the tabs now closes its menu, and a second press on the `+` closes
  it rather than reopening it.
  
  Search results now drop from the search field — a card under it on a wide
  screen, everything under the bar on a phone — instead of taking over the notes
  column. Arrow keys move through them and Enter opens one. Choosing a result
  opens the note, empties the field and, on a phone, closes the search.
- c2a0296: Fixes from a whole-codebase review. Nothing here changes the file format or the
  database schema.
  
  Sync. A note no longer ends up at a path its file has left when a round renames
  its folder away and moves the file back to the old name — the pull said `ok`
  and the next edit blocked the queue. A second connected source whose files name
  note ids another source on the device already holds now syncs; it used to fail
  identically on every retry, for ever. A cycle in the id tree an OneDrive or
  Drive cursor carries — a legitimate state between two pages — no longer
  overflows the stack on a large library.
  
  Editor. A sync pull into a note open in rich mode no longer saves a conflict
  copy nobody typed: changes Milkdown's own plugins make in answer to a loaded
  body (heading ids, table repair) were being counted as the user's. Undo after a
  pull no longer puts the pre-pull text back and pushes it over someone else's
  edit; an adopted body empties the undo history in both editors.
  
  Deleting a note can be undone for about ten seconds, from a notice or the
  palette, whether or not the delete has already synced. The note goes back to
  the source it was deleted from, keeps its path, and anything that took the name
  meanwhile moves aside. Text the editor still held comes back with it — as the
  body, or beside the note where something newer had been stored since.
  
  Saving. A save that fails is said, in the note, and retried — newest text
  first, never an older body over a newer one — where it used to be dropped
  silently. A tab left open across a schema upgrade made by a newer
  build in another tab now finishes its writes, closes, and asks to be reloaded,
  rather than carrying on writing with old code into the migrated database. A
  tab that opens after the upgrade was made closes at once, writing nothing, and
  asks the same. The notice can be
  put aside to copy text out.
  
  Files. An `id:` the user wrote that the app cannot use (`id: 202409141302`) is
  left as written instead of being replaced by a UUID on first save, in the note
  and in a conflict copy of it, and is not respelled (`0123` stayed `0123`) when
  the title or tags are written. A frontmatter block closed by `...` is read as
  one, the same way before and after the app's own save (which fences the block
  with `---` where the body's first line would otherwise be taken for its closer), and an unclosed block no longer swallows prose up to the next `---`. File
  names are cut between grapheme clusters and capped at 216 bytes as well as 120
  code points, and a conflict copy's name is fitted to 255 bytes, so an emoji at the boundary cannot produce a name OneDrive's
  adapter throws on; existing files are not renamed.
  
  Shell. A crafted `?note=` link can no longer crash the app — search params a
  route refused were reaching components anyway — and a render error now shows a
  screen saying the notes are safe, with Reload and Try again. In the storage
  panel, "Stop syncing on this device" after a failed disconnect can no longer be
  pressed under a different source than the one that failed.
- aad3c12: Search asks every connected source at once. The field has moved out of the
  notes column and into the bar across the top, at its right-hand end, and its
  answers say which source each match is in when there is more than one, and
  which notebook. Opening a match switches to that source, opens that notebook
  and opens the note, so the tabs, the sidebar and the list all agree about where
  you are. The way to connect another account now sits with the tabs, right after
  the last one, rather than at the far end of the bar.
- 7d827cf: When a note has something the rich editor can't show, the banner now says what
  it is and which line it's on — "The rich editor has no way to show a link
  reference definition on line 5" — rather than only that there is something.
  
  And the note is no longer stuck in markdown mode for as long as it stays open.
  Once you have changed it, the rich text tab (and Ctrl/Cmd+E) is offered again;
  pressing it saves what you typed, then opens the rich editor, which checks the
  note again before you can type. If it still can't show the note, you are back
  in markdown mode with the banner saying what it found this time, and nothing
  in the note has been changed.

### Patch Changes

- 8b06a60: The app has its own icon, a white page with a gold curled corner on blue, in the browser tab, on the home screen and when installed, in place of the placeholder. The blue is the primary button's colour and the colour of links too.
- 1446f4f: Code blocks now say what language they are written in, and both editors colour
  what is inside them. A fence had a language in the file and nowhere on screen:
  the rich editor drew a plain `<pre>` and the only way to set or change the word
  after the backticks was to switch to raw mode and type it.
  
  A bar of tools floats under the code block the cursor is in, and under no
  other: nothing sits above the code, where a row of controls on every block
  would be a row of controls in the way of every block. On it are the language
  picker, wrapping, line numbers, copy and delete.
  
  Choosing a language rewrites the fence's info string, which is an edit like any
  other — it changes the file. A fence that says `js` shows as JavaScript without
  being rewritten to `javascript`, and a language this app has never heard of —
  `mermaid`, something from another tool — keeps its word, keeps its place in the
  picker, and is simply left uncoloured.
  
  Wrapping and line numbers are the reader's settings rather than the note's:
  there is nowhere in markdown to write either one, so they apply to every code
  block in every note and are remembered on this device until they are changed
  again. Nothing either of them does touches a file.
  
  Thirty languages, each fetched only when a note actually holds one, and all of
  them available offline. The list is curated rather than the whole of
  `@codemirror/language-data`: every language is a chunk the service worker
  precaches, so the list is what the app downloads to be able to work offline —
  thirty is about 550 KiB of grammars and nothing added to the first load, where
  a hundred and sixty would be several megabytes of languages nobody opens.
  
  Raw mode colours the inside of a fence too, with the same grammars and the same
  palette, so a code block looks the same whichever mode the note is open in.
  Markdown's own syntax stays in black and white there: raw mode is the mode
  where the characters are the formatting.
  
  Inline code is now drawn as a chip — monospace, a tint, a thin edge and its own
  ink — so a `--flag` in the middle of a sentence is visibly not the sentence.
  
  A block that names no language says "Detect language", and means it. Turning
  text you have already written into a code block guesses from that text: select
  a snippet, press the button, and the fence comes with `python` or `sql` or
  `diff` already on it. A block started empty works it out as it is typed or
  pasted into, and stops asking the moment it has an answer — a language you
  picked yourself, or one the file came with, is never second-guessed. The guess
  rides along with the edit that prompted it, so a single undo takes back both.
  
  It only answers when the text is distinctive: prose, a path, a list of names or
  a snippet that could as easily be Java as C# stays blank, because a blank
  picker costs a click and a wrong word in the fence has to be noticed before it
  can be undone. Text the app itself puts in the editor — a sync pull, a switch
  back from raw mode — is never labelled: a note nobody typed in comes back byte
  for byte.
  
  A note that ends in a code block has a way out of it again. Clicking below the
  last block used to put the cursor inside the code, because that was the nearest
  place a cursor could go, and typing added a line to the code sample. There is
  now a strip under such a block — and a button on it for the keyboard — that
  puts a paragraph after it. Clicking it and then thinking better of it costs
  nothing: the note is not marked as changed, and the empty paragraph is taken
  back when the cursor leaves it.
  
  Selecting text inside a code block no longer brings up the floating formatting
  toolbar. A code block holds no marks, so every button on it was a button that
  did nothing.
  
  The toolbar has a code block button, the one insert it offers; the rest — a
  table, a quote, a divider — still comes from the `/` menu. It lights up inside
  a code block and pressing it again gives the block back as plain text, and the
  mark buttons are grey in there, since a code block holds no marks.
- aad3c12: The menu behind the source bar's `+` is now the same kind of menu the editor
  toolbar has, a card with a row per provider, and the `+` itself sits on the
  tabs' baseline without a rounded corner up against the top of the window. The
  tabs line up along the bar's bottom edge and no longer change width when one
  is lit. The note's header is the same height as the two pane headers beside
  it, so the three bottom rules meet. Clicking the title of a note that has none
  selects the "Untitled" placeholder, so typing replaces it rather than landing
  in the middle of it.
- e040ecf: Groundwork for disconnecting a source without leaving notes where nobody can
  see them. Nothing a user can see has moved: the app can now say what a source
  holds that its remote has not been sent, have the editors write what they are
  holding and report what would not save, and build a ZIP of notes for download —
  none of which is called from the interface yet. The one change to stored data is
  that each connected source's row now remembers what the server last called the
  account, so a source can still be named once the server stops answering for it.
- b58738d: The rich editor now fills the pane it appears to fill. The editable surface was
  only as tall as the words in it: everything below the last paragraph looked like
  the note and was not, so a click there put the cursor nowhere. Milkdown puts a
  container of its own between the element it is handed and ProseMirror's, and
  with no height on it the surface's `min-height: 100%` had nothing to resolve
  against. Every element in that chain now grows.
  
  Above it there is a formatting toolbar, grouped the way Atlassian's editor
  groups one: text style, then bold and italic with the rest of the marks behind
  a "More formatting" button, then the three kinds of list, then indentation,
  then the link.
  
  What is missing from it is missing because markdown cannot hold it — there is
  no text colour, no highlight and no alignment in a `.md` file. Insert is not
  duplicated either: a table, a code block, a quote or a divider still comes from
  the `/` menu. The style menu offers headings down to six, two deeper than `/`
  does.
  
  Indentation is list nesting, which is all indentation means in markdown, and
  both buttons are grey wherever nesting would not happen — including the first
  item of a list, where there is nothing above to nest under. A lit mark button
  means the next press takes that mark off.
  
  The bar is one stop in the tab order with the arrows moving inside it, so it is
  not fourteen presses of Tab between a note's title and its text, and it appears
  only in rich mode: raw mode is markdown, where the characters are the
  formatting.
  
  Lists work properly as well, which they did not before. Switching a bulleted
  list to a numbered or task list — or back — now changes the list, where the
  preset's commands would only wrap a second list around it and so appeared to do
  nothing. Pressing the button for the list you are already in takes the list off.
  
  A new item beside task items is now a task item, and an unticked one. Pressing
  Enter at the end of a finished task used to hand back a second task already
  ticked, and a double Enter two levels into a checklist left a plain bullet
  behind.
  
  Task checkboxes can be ticked. The box used to be a character drawn in the
  stylesheet, which nothing can press; it is a real checkbox now, and `Mod+Enter`
  does the same from the keyboard. Ticking an item ticks everything under it, and
  unticking a child unticks the item above it, as far up as that goes — nothing
  above an unfinished task is finished. Unticking an item leaves its children
  alone: that says the item is not done, which says nothing about work already
  finished. Adding a
  new sub-item unticks the item above it for the same reason: adding to what
  something consists of is saying there is more to do. A note that arrives from
  elsewhere with a finished parent over an unfinished child is left as it is —
  only a parent your own edit left that way is corrected.
  
  Ticking the last of a parent's children does not tick the parent: that is a
  task in its own right, and may have a step nobody wrote down.
- 135829d: A table with an empty cell no longer sends its note to markdown mode. The rich editor wrote every empty cell back as `<br />`, a break the note never had, so the check that keeps it from rewriting a note refused the whole note. An empty cell is now written empty, including in a table made in the rich editor, and a `<br />` written into a cell is still kept as it was.
- c228479: An operator's `EntitlementProvider` is asked at the OAuth callback as well as at
  `/api/token`, before anything is stored. An account it refuses no longer leaves
  a refresh token sealed in the database: nothing is stored, the consent just
  given is withdrawn where the provider has a call for it, and the app says the
  account cannot sync on this server. For operators: `EntitlementSubject`'s
  `connectionId` is now optional, and is absent when the account is connecting
  for the first time.
- a1b7406: A note that opens with a heading or a paragraph no longer starts lower in the rich editor than it does in markdown: whatever block comes first adds no space above itself, so its first line sits under the note's title.
- 0d7535c: The shell's `Strict-Transport-Security` header no longer says
  `includeSubDomains`. Served from an apex domain it committed every subdomain the
  operator owns to HTTPS for two years; that is theirs to decide, and
  `docs/self-hosting.md` says how to add it back. The Node floor is 22.13, the
  first 22.x where `node:sqlite`, which the API tests use, needs no flag.
- ba48ecc: A `<br />` inside a sentence no longer sends the note to markdown mode. The
  rich editor was deleting it — `first<br />second` became `firstsecond` — and
  the check that protects notes from the editor caught that and locked the note
  in markdown mode with a banner. Now only the `<br />` the editor itself writes
  for an empty paragraph is read back as one; a break the author wrote, in any
  spelling and anywhere in the note, stays exactly as written.
  
  A `<br />` on a line of its own inside a paragraph works too. When the note is
  next edited in the rich editor, the line ending just before it becomes a
  space — the markdown writer does that to any inline HTML at the start of a
  line, so it cannot be mistaken for an HTML block — which reads and renders the
  same.
- d0c5fe2: The storage panel no longer tells you to check a connection that was never
  used, or that an account is still connected when it is not.
  
  Disconnecting, connecting and removing a device are each a few writes on this
  device around one call to our server, and until now any failure of any of them
  was reported as the server's: "the server cannot be reached". That was plainly
  wrong for "Stop syncing on this device", which asks the server nothing at all —
  a store that refused a write there sent you to look at your connection, and
  offered you a server to try again.
  
  Each of the three now says which half failed, because the code that made the
  call says so rather than guessing from the error, and each tells a server that
  answered with a failure — worth trying again — from one that never answered,
  which is worth looking at the connection for.
  
  No message claims an outcome it does not know. Everything after the server
  disconnects an account is this device's own work, so a failure there can leave
  the account gone at the provider and this device still syncing it; the message
  says so and offers a retry, which is safe, rather than telling you the account
  was not disconnected when it was. A failure the app cannot place at all — after
  a call has already done whatever it did — says neither where it happened nor
  whether it worked.
  
  Connect failures are also announced now, as the panel's own already were.
- b568603: "Connect again" now signs out the credential the device held before, so it no
  longer lingers in the device list for 180 days as a device that is not one and
  a live key to the account.
  
  On the server, revoking the last live device of an account disconnects it: the
  row is deleted and the grant withdrawn at the provider where there is a call
  for it, rather than being left as a live refresh token nothing can reach or
  revoke. `DELETE /api/connection/grants/:id` answers `disconnected` (and
  `revoked` when it is) alongside `ok`. The web app's device list only removes
  *other* devices, so this is reached through the API; an account whose only
  device clears its site data is still not cleaned up.
- cc724cb: Sign-in separate from storage is dropped rather than deferred: identity and
  storage are coupled, so a person is their storage account.
  
  Two things a user or an operator can see. The refusal for
  `AUTH_MODE=account-first` now says the mode is not implemented **and will not
  be**, rather than "not implemented yet" — a decision rather than a schedule.
  And the client stops carrying three connect outcomes the server retired in
  Phase 7: `conflict`, `occupied`, and `signin`, which rendered "Sign in before
  connecting storage" for a product that does not exist. A stale link carrying
  one of them used to render an empty red banner; now it renders nothing.
- ee93f2f: The notice after connecting a storage account, and the one saying why a note or
  a notebook could not be made, are now cards floated over the page rather than a
  thin grey bar across the top of the frame.
  
  The bar was missable, which was found the way these things are: an account was
  connected with Google's files permission unticked, the app said so correctly,
  and the line was read only after being looked for.
  
  Each card is coloured by what it is — success, warning or error — as a bar down
  its leading edge and a wash mixed into the surface behind it. The words stay
  `--fg` on what is within a few percent of the colour they were designed
  against, so the message's contrast does not depend on its tone, and a warning
  or an error is bold as well as coloured: the colour is the one thing a reader
  may not be able to see. `role` follows the tone — `status` for a success,
  `alert` for the other two — so what a screen reader does is unchanged.
  
  Giving them colour meant deciding what each message *is*, which turned up one
  that had been wrong all along: a note brought back into the source it was
  deleted from was announced as an `alert` alongside the genuine failures, and is
  a success. Restored into a source that is now disconnected is a warning, and an
  unticked permission is a warning too — everything worked exactly as asked and a
  tickbox fixes it — where a server that will not have the account is an error,
  because trying again cannot help.
  
  Three ways out and no timer: Dismiss, touching anything else on the page, or
  navigating. Pointers only, so an error can be read with the cursor still in the
  note it is about. The undo-delete notice deliberately does none of this — a
  click anywhere taking away the only route back from a delete would lose work —
  but it does join the same stack instead of placing itself 5rem up to dodge the
  new-version prompt, so two notices at once sit above one another rather than on
  one another. The card the four of them share is one rule; only the placing and
  the tone differ.
- aad3c12: Clicking a notebook no longer clears the open note when the note is in it, or
  in a notebook inside it. Clicking the parent of the notebook a note was in used
  to leave an empty editor beside the list. When the open note is somewhere else,
  or nothing is open, the notebook's most recent note opens instead, so a
  notebook with notes in it never opens as a blank pane. Deleting the open note
  does the same: the most recent of what is left in the notebook opens, and the
  pane is empty only when the notebook is.
- 1bd5413: Renaming a source tab no longer changes the shape of the tab. The field wears
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
- 8c1fd73: Fix a notebook moved to another notebook — or out to the top level — leaving a duplicate of itself and everything under it behind, on the remote as well as in the sidebar. Moving or deleting a notebook queued one directory removal, for the outermost directory only; every directory below it had nothing naming it, so the sync that ran next adopted them as new notebooks before the push could remove them, and the removal was then refused because the device held a notebook under that path again. Each directory now gets its own op. The whole-app sync suite also runs over Dropbox now, which it did not before.
- 7d827cf: The `/` menu now closes when what you've typed after the slash matches no
  command. `/nothing` used to leave an empty box under the cursor. Delete back
  to a query that matches something and the menu opens again.
- 1bd5413: The storage accounts on a device are tabs across the top of the app, named
  "Dropbox", "OneDrive" and "Google Drive" — with a number on the second of a
  provider, "Dropbox 2" — and renamable to whatever the user likes.
  
  A device can hold several accounts at once, each its own notes, notebooks,
  queue and cursor, and the only way between them was a list at the foot of the
  storage panel. That answered "switch me" and never "which of these am I
  looking at", which is the question the panes below the bar depend on. Every
  source is up there: the live ones, the detached ones — they hold work their
  remote was never sent and can still be written in, so leaving them out would
  hide notes — and the device's own pile when it holds anything. Disconnected
  says so in words, not only in colour.
  
  Pressing the tab that is already showing turns it into its own name. Enter
  takes it, Escape abandons it, clicking away takes it; clearing it puts the
  derived name back. The name is this device's, kept apart from the one the
  server gives: that one is overwritten on every reconcile and a rename stored
  there would not survive the next one. A `+` at the end of the bar offers the
  providers the deployment has.
  
  Numbering is derived rather than stamped on at connect time, so sources
  already on a device get names with no backfill and letting the first Dropbox
  go leaves the other one called "Dropbox" instead of a "Dropbox 2" with no 1
  above it. A name the user chose is never moved by that.
  
  The sidebar gives connection management up in return. The source list and the
  "Connect another…" buttons are gone from the storage panel, which now holds
  only what is true of the source in front — how syncing is going, the devices
  holding its credential, and Disconnect. A detached source keeps Reconnect,
  which is how work that was never sent gets home rather than a way to add an
  account. There is one list of sources now instead of two that named them
  differently.
  
  The notebooks scroll inside the sidebar rather than the sidebar scrolling as
  one, so the storage panel sits at the foot of the pane instead of at the end
  of the content, where enough notebooks pushed it below the fold. At phone
  width, where the pane is 14rem and there is nothing to divide, it scrolls as
  one as before.
- d12f713: On a touch screen every control is at least 44px both ways — the editor's tabs, the header and pane icons, menus, list rows, the formatting toolbar, the code-block tools, dialogs and toasts — and a task's checkbox is 24px. A mouse keeps the denser layout. Fields are 16px on touch, so iOS no longer zooms into them.
- 4ca6bad: A file in the notes folder that is not UTF-8 text — saved as Latin-1 or UTF-16
  by another tool, or a binary that happens to be named `.md` — is now left
  alone. It used to be decoded anyway, arriving as a note with `�` wherever a
  byte would not read, and the next push (even the app adding an `id`) wrote that
  damage over the original. Now nothing is imported and no note stays bound to such
  a file, so once a sync has seen it nothing the app sends can land on it. A note
  with no unsent edits
  whose file became unreadable goes from the device; one with edits keeps them,
  under a conflict name, and they go up as a new file beside the one that could
  not be read. A sync no longer stops on such a file, and reconnecting a folder
  whose notes have all been re-saved that way still recognises it. Save the file
  as UTF-8 and it is picked up on the next sync. Listing these files in the
  storage panel follows separately.
  
  Text holding a NUL character counts as unreadable too, since that is what UTF-16
  without a byte-order mark and most binaries look like. So the app never writes
  one: a NUL pasted into a note is dropped by the editor as it arrives, and again
  as the note is saved or a file is imported.
- 0b73ab7: The storage panel now says which files it is not showing. A file in the notes
  folder that is not UTF-8 text is left alone, and until now nothing said so: a
  note whose file another tool re-saved as Latin-1 simply went from the device.
  Each connected source now lists those files by path under its sync status, with
  what to do about it — save the file as UTF-8, or delete it — and the line goes
  once the file reads, is deleted, is renamed to something that is not a note, or
  a re-scan no longer finds it. A note of yours that had to move aside because
  such a file has its name is reported like any other conflict copy.
  
  The list is kept with each source's sync cursor and written in the same step, so
  it never names a file from a sync that did not finish, and "Re-scan from
  scratch" keeps it until the scan has looked. It is a notice only: nothing the
  app decides depends on it, and a file on it is still read again every time the
  provider mentions it.
  
  For anyone implementing `SyncStore`: there is one new read, `unreadable()`, and
  two new `PullChange` kinds, `unreadable` and `forget-unreadable`; `move-folder`
  carries the listed paths under a folder along and `delete-folder` drops them.
  The store contract suite covers all of it.
- Updated dependencies [751d856]
- Updated dependencies [74e5bc6]
- Updated dependencies [c228479]
- Updated dependencies [480405f]
- Updated dependencies [30a5c70]
- Updated dependencies [ba48ecc]
- Updated dependencies [15f05a4]
- Updated dependencies [8bb745f]
- Updated dependencies [470c58e]
- Updated dependencies [ceb0e5f]
- Updated dependencies [1fdbf29]
- Updated dependencies [c2a0296]
- Updated dependencies [4ca6bad]
- Updated dependencies [0b73ab7]
- Updated dependencies [7d827cf]
  - @skysa/core@0.2.0
