# @skysa/web

## 1.0.4

### Patch Changes

- aa1eefc: On a phone, Back no longer jumps from a note to the notebook open before it, which on Android looked as if the end of the swipe had tapped a notebook. Back now goes back through the dropdowns: from a note to the notes it was chosen from, then to the notebooks, then to the note before. With a dropdown open, Back shuts it.
- @skysa/core@1.0.4

## 1.0.3

### Patch Changes

- c8f0ef4: On a phone, the compact bar no longer shortens a notebook's or a note's name that has room to show whole — `Bugs` was showing as `B…s` — and a long name chosen after another is shortened to the room it has, not cut as though it were as long as the one before.
- 3b4646d: On an iPhone, the toolbar under a scratch note is no longer stretched tall: opened over the whole screen, its buttons sit in one row clear of the home indicator, and in the box on the scratchpad and in the dialog on a wide screen it no longer leaves room for one.
- @skysa/core@1.0.3

## 1.0.2

### Patch Changes

- 4ec60fb: On a phone or tablet, a note's title no longer has a ring drawn round it while it is being typed in, in the scratchpad or in a notebook.
- @skysa/core@1.0.2

## 1.0.1

### Patch Changes

- ba00d11: Scratch notes made on another device before this one had the scratchpad now arrive: each source reads its storage once more after the update, downloading only what this device is missing.
- @skysa/core@1.0.1

## 1.0.0

### Major Changes

- Version 1.0. An instance on 0.21 moves to it with nothing to do: no setting, secret, binding or database migration is new. From here on the number keeps semver's promise to the person running an instance — a major version is one they have to act on, and a minor or patch version never is.

### Minor Changes

- d544a21: A scratchpad for quick notes, for every source, the device's own notes included. It is shown for every source until it is hidden from the storage menu ("Hide scratchpad"), and a source connected after one was hidden starts hidden. It sits above the notebooks: a "Take a note…" box, and the notes taken as cards, the pinned first. A note there has the basic tools — bold, italic, lists, a link — and can have files attached. A card can be pinned and given a colour, which are kept in the note's file and so reach every device. A card shows its note as the note is set — bold, lists, boxes, headings, its pictures and files — and opens from a press anywhere on it but its tools. It opens in a dialog, or the whole window on a phone, growing out of the card and going back into it as it closes, and the "Take a note…" box eases open and shut. "Move to notebook" makes it a full note, named first if it has no name. Scratch notes are ordinary notes in a hidden `.scratchpad` folder, synced as any note is, and search finds them while the scratchpad is shown.
  
  Labels are spelled the American way where they were not: "Canceling…" while an import is called off, and "Connecting storage was canceled."
  
  On a phone, or in any window too narrow for three columns, the source dropdown now ends with the storage gear, as the sidebar does on a wide screen. It has what the source's ⋯ has, and is there before the device has a note to give it a row.
  
  When the formatting toolbar is short of room, its More tools button now sits straight after the last tool it shows, instead of out at the bar's far end with a gap between them.

### Patch Changes

- b45ae3f: The storage panel and the question before connecting now write their counts with a thousands separator, so "1,028 files" rather than "1028 files".
- 453558c: Scratch cards draw their pictures from small copies, and hold each picture's room before it arrives, so the wall stops rearranging as pictures come in.
- 724b3ec: The clipboard panel draws its pictures from small thumbnails made on the device, rather than decoding each full picture.
- 445d4b6: A source let go of on this device no longer has all its notes read each time another source syncs.
- 5060f63: The editors' words now come from the app's catalog. A size or a count of a thousand or more in what the editor says about a picture or a file is now written with a thousands separator: "1,024 MB", "1,028 files".
- a68cbd3: The words the app writes into the user's files where a name gives none, the alt text of a pasted picture, the link text of a file with no name and the folder of a notebook given no usable name, now come from the app's catalog. `@skysa/core` takes them from its caller (`attachmentLabel`'s `words`, `sanitizeFolderName`'s `unnamed`). A note with no name stays `untitled.md` and `UNTITLED_TITLE` in every language, and is shown in the catalog's words (`notes.untitled`). `ClipName.label` is now `undefined` for a pasted text or a picture with no name of its own, and `fileKindLabel`, which nothing used, is gone. The English is unchanged.
- 88d3e32: A scratchpad of hundreds of cards no longer reads every card's frontmatter again each time it is drawn.
- 8eb2749: The find bar's match count and the number of files in something shared to the app are now written with a thousands separator, as in "1,028 of 2,048".
- 7c5bc6b: A sync run that brings nothing no longer reads every note again for the notebooks, the note list and the loose-notes count.
- c747751: Clicking back to a notebook soon after leaving it opens the note left open there, rather than its newest, on a busy device. Before, the newest note could open and was then remembered in its place.
- f1e3ab3: The words of importing, downloading, the clipboard and the scratchpad come from the app's catalog, and a count of a thousand or more in them is now written with a separator ("and 1,028 more", "without 1,028 files") where it was not.
- b89ffe1: A notebook of more than 150 notes draws only the rows near the screen, so a long list opens and scrolls faster on a phone.
- 6e79839: The note list draws a row again only when what that row shows changes, so saving one note in a notebook of a thousand no longer redraws the other 999 rows.
- ef0b330: The number of notes and files in the question asked before a notebook is deleted, and a file's size in a notebook's attached files and the clipboard, are now written with a thousands separator: "1,028 notes", "1,000 KB".
- 5c581f7: A note's pictures are drawn from smaller copies made on the device, as wide as the editor draws them, one at a time; a picture's box keeps its size while it loads, and a copy stands in for a picture that cannot be downloaded now.
- 5f2a655: A picture beside a note, selected, has Open full size and Download on its bar, as a file's chip has; Enter opens it, and Tab reaches its bar.
- ab8ff78: A notebook or scratchpad with more than 400 notes no longer parses every note's preview again each time its list is drawn, which it was doing on every autosave of the note beside it. The cache of previews now grows with the lists on screen, and a scratchpad card's text is parsed once instead of twice.
- c39a721: Importing a library, or pulling one into a device for the first time, reads its notes a little at a time before writing them, so a phone no longer stops answering until a few thousand notes are in, and the rest of the app can read the notes while they are being read.
- 2740053: The scratchpad places its cards in one pass and draws a card again only when what that card shows changes, so opening a card on a large scratchpad takes a fifth less work.
- cf35475: Opening a scratchpad of hundreds of cards no longer holds the page still while every card's height is guessed: the cards are guessed a few at a time from the top, and the wall grows as they are.
- c0898e4: A scratchpad of hundreds of cards shows its first cards sooner: to find the pinned ones, only the frontmatter that says `pinned` is read.
- d195e19: A scratchpad of more than 100 cards draws only the cards near the screen, so it opens and scrolls faster on a phone.
- 9b6454e: Search builds its index as the field takes the cursor, a little at a time, so typing into it on a phone no longer stalls: the first letter is answered without a second's wait, and each letter goes into the field before its matches are drawn.
- 26b1ffb: A picture shown in a note and on its scratch card at once is held in memory once instead of twice, and a scratchpad of picture cards watches its source's files with one query instead of one per card.
- 2f88aa4: The sidebar builds its tree in one pass and draws a notebook's row again only when that row changes, so an autosave, a sync run or a drag over the notebooks no longer redraws every row of a large library.
- 374d1f1: Counts in the source tabs, the disconnect and move questions, a disconnected source's panel and the first import's progress are now written with thousands separators in English digits ("1,240 found so far"), where they had no separator or followed the browser's language.
- 5db5a77: Two tabs open on different notebooks of a source no longer write where the user is back and forth for as long as both are open.
- Updated dependencies [a68cbd3]
- Updated dependencies [678324c]
- Updated dependencies [d544a21]
- Updated dependencies [4014eed]
- Updated dependencies
  - @skysa/core@1.0.0

## 0.21.2

### Patch Changes

- d3c7c96: On a phone, or in any window too narrow for three columns, a long note name in the note dropdown is now shortened in the middle, as a notebook's path is, rather than at its end: `Forecas…ond half`, so two notes that start alike can still be told apart.
- @skysa/core@0.21.2

## 0.21.1

### Patch Changes

- 7c4541b: On a phone, or in any window too narrow for three columns, the notebook dropdown now shows the notebook's full path, as the heading over the notes does, instead of its name alone. When the bar is short of room the path is shortened in the middle: the notebooks it is in give way first (`Work/Proj…/Q3`), and the notebook's own name last.
- Updated dependencies [7c4541b]
  - @skysa/core@0.21.1

## 0.21.0

### Minor Changes

- 9506a64: A notebook with notebooks inside it now lists their notes too. Its own notes come first, then each inner notebook's notes under that notebook's name, in the order the sidebar shows them. Choosing one of those notes opens the notebook it is in, with the note. A notebook's count in the sidebar is every note inside it, at every depth, whether it is open or shut.

### Patch Changes

- @skysa/core@0.21.0

## 0.20.3

### Patch Changes

- 11482ec: Resizing the window no longer crashes the note at some widths, around 1080px on a desktop. At those widths the formatting toolbar could not settle on which buttons fit, moved one into its "More tools" menu and back for ever, and React gave up on the page. The toolbar now settles at once at every width.
- @skysa/core@0.20.3

## 0.20.2

### Patch Changes

- 62f79e6: While the clipboard holds anything it is highlighted, with a tint of the brand's colour, an edge in that colour and a soft glow around it, in place of the shading inside its edges. It stays the full width of the sidebar. The edge thickens inward, so the items never move, and the glow grows while files are dragged over the window, and most with them over the clipboard.
- 30d577e: The app moves more smoothly, and all of a piece. Hover, selection and anything switched on fade in rather than blink. Menus open out of the button that opened them, upward where they rise from the foot of the sidebar or of a phone's note. Dialogs and the command palette rise in as the page behind them dims, and notices slide up from the bottom. A notebook's notebooks, new clipboard items and the find bar fade in. With reduced motion turned on in the system settings, nothing moves and only colours fade.
- @skysa/core@0.20.2

## 0.20.1

### Patch Changes

- e99c67f: The clipboard is easier to read and to drop things on. It has a section of its own above the storage status, ruled off from it across the sidebar. It glows a little in the brand's colour while it holds anything. Dragging files anywhere over the window shows "Drop here to add to clipboard", and the glow brightens with the files over it. An item still being sent is greyed out under a small spinner until it is up. "Copied" and "Saved" now show over the item you pressed, and items show a hover state. While the clipboard is empty, the text that explains it now sits in a dotted box and says to click or tap an item to use it.
- Updated dependencies [3eaa0b5]
  - @skysa/core@0.20.1

## 0.20.0

### Minor Changes

- 3b0c428: The browser's Back and Forward buttons now move between the notes and notebooks you opened, including back into another source after switching to it. The address bar names the open note by its notebooks and its name, as lowercase words joined by hyphens, such as `/#/work-stuff/projects/q3-plan`. A link or bookmark to a note opens it, including one typed with the names as they are, and the address follows the note when it is renamed. The page title says where you are: `Work > Projects > Q3 plan`. Notebook and note names stay in the part of the address after `#`, which the browser never sends to the server. Links from earlier versions, which named a note by `?note=`, now open wherever you last were.

### Patch Changes

- b072a30: With instant updates between devices turned on, a change made on another device no longer sometimes waits a minute to arrive. Google Drive takes a few seconds to report a change, and a device used to ask it once and then wait for the next minute's sync. It now looks again a few seconds later. This was most noticeable with the clipboard: an item added, or several removed one after another, could take a minute to show on your other devices. An item removed from the clipboard on another device also no longer stays on this one until the next change to the clipboard.
- @skysa/core@0.20.0

## 0.19.0

### Minor Changes

- 3306900: While the app runs in a browser tab, a banner under the top bar offers to install it. In Chrome and Edge, on a desktop or Android, its Install button opens the browser's install prompt. On an iPhone or iPad it says to tap Share, then Add to Home Screen, and in Safari on a Mac it says to choose File › Add to Dock. Browsers that cannot install the app are not offered it. The banner goes once the app is installed or opened as an installed app, and dismissing it hides it for good on that device.
- ac23b8f: The installed app is a share target on Android and ChromeOS. Text, links and files shared to it from the system's share sheet go on the clipboard of the source showing, once the user says so. The app always asks, naming what came, and offers to show the clipboard where it is hidden. Files over 25 MB are left out and named. Notes kept on this device only, and a source no longer connected, have no clipboard, and the app says so. The service worker answers the share itself and keeps it on the device until the page has asked; nothing shared is sent to the server.
- 1fe2319: A clipboard a source's devices share. "Show clipboard" in a connected source's storage menu (the gear, or the source's `⋯` on a phone) puts a Clipboard region above the status line, on this device. Paste reads text or a picture from the system clipboard. A keyboard paste or a drop on the region, or "Add a file", adds files of up to 25 MB. Each item shows as a text preview, a thumbnail or a file card. Pressing one copies text or a picture back to the clipboard and saves a file. It keeps the last 10 items, newest first, and pasting something already there moves it to the top. Items are files in a hidden `.clipboard` folder in the app folder. A paste is kept on the device at once and sent when online, and where the instance runs the change relay, the source's other devices show it within a second or two. Not offered for notes kept on this device only. Turning it off only hides it, and disconnecting a source drops its clipboard from the device.
  
  `@skysa/core` exports the clipboard's naming (`clipName`, `readClipName`, `clipStamp`, `clipPath`, `isClipPath`) and its folder and cap (`CLIPBOARD_FOLDER`, `CLIPBOARD_ITEMS`). A sync's outcome now says when a pull met that folder (`SyncOutcome.clipboard`).

### Patch Changes

- Updated dependencies [1fe2319]
  - @skysa/core@0.19.0

## 0.18.2

### Patch Changes

- 2a543dc: Menu items no longer end in "…". "Disconnect…", "Import a folder…", "Import files…", "About Google Drive…", "Move to notebook…" and the format toolbar's "Link…" now read like every other menu item: "Disconnect", "Import a folder", and so on.
- @skysa/core@0.18.2

## 0.18.1

### Patch Changes

- 9e1acc7: On a phone, the source dropdown's storage panel now ends in the same line as the foot of the sidebar: the source and a few words on how syncing is going ("Google Drive · Synced 9:41"), with the bar under it during a long sync. The count of other devices sits at the end of that line and opens the same list as on desktop. "About Google Drive…" is now in the source's `⋯` menu instead of folding out under the source's name. The "Syncing with … · account" heading and the full-sentence status above it are gone; problems that need the user are still spelled out above the line.
- @skysa/core@0.18.1

## 0.18.0

### Minor Changes

- d555ebc: On an instance that runs the change relay, the app holds a socket to it for the source on screen, while the app is in front of the user and online. A device that has just pushed says so, and the connection's other devices sync within a second or two instead of at their next poll. Polling goes on as before, and an instance without a relay is never asked for a ticket: the app asks `/api/config` first. The socket closes when the tab is hidden, goes offline, switches source or is disconnected. It reconnects with backoff after a failure, at once when its hour is up, and never after the device has been signed out.
  
  `@skysa/core` now exports the relay's wire protocol, so the two ends cannot drift: its two messages, its keep-alive, its close codes and its throttle.

### Patch Changes

- Updated dependencies [d555ebc]
  - @skysa/core@0.18.0

## 0.17.1

### Patch Changes

- bca2080: A long sync on a phone no longer starts over when the screen goes off. A pull that fails part-way, as one does when a phone's screen times out and takes the network with it, keeps the notes it had already read, and the next try reads only the rest; before, a batch of up to a thousand notes on Google Drive was downloaded again from the first. While a sync long enough to show a count is running and the app is on screen, the app also asks the browser to keep the screen on, and lets go when the sync ends.
- Updated dependencies [bca2080]
  - @skysa/core@0.17.1

## 0.17.0

### Minor Changes

- d8f1140: The storage panel at the foot of a wide window's sidebar is now one line — the source and how syncing is going, with the account in its tooltip — and a gear whose menu holds Sync now, Re-scan, the download, the imports, Stop syncing and Disconnect, the same items as a source's `⋯` on a phone. How many other devices are signed in stays in the line, beside the gear, and opens their list over everything. What Google Drive keeps from the app is in the gear as "About Google Drive…".
- bbd503b: Notebooks and notes can be pinned to the top of their list from the `⋯` on their row, or a right-click: "Pin to top", and "Unpin" once pinned. A pinned notebook goes to the top of the notebooks under its own parent, a pinned note to the top of its notebook's list, and a pinned row is tinted. Pins are kept on this device, per source, and follow a notebook that is renamed or moved.
- 6fbffb5: A long sync now says how far it has got. The engine counts a round from a stored cursor as it receives it (`SyncProgress` gains a `receiving` stage), so a device picking up another's import of a thousand notes is no longer silent until all of it lands. The storage panel shows a run of twenty or more as a count in its status line — "Sending 120 of 1,000", "Receiving 5 of 30", "Looking for notes: 40 found" — with a bar under it and the file it is on in the line's tooltip; in a compact window the panel says it in a sentence over the bar.

### Patch Changes

- dc3bca7: An imported library, or the notes a device brings to the first account it connects, is now sent notebook by notebook: each notebook goes up with its notes and the files beside them before the next one starts. Another device fills in a notebook at a time, rather than showing every notebook empty until the notes arrive.
- 62ce687: A sync to Google Drive sends up to four notes at once rather than one at a time, so a large import reaches it several times faster. A provider says how many it takes (`StorageProvider.writesAtOnce`); Dropbox and OneDrive still take one, since Dropbox refuses writes that meet one another as a rate limit. Notebooks, moves, deletions, files beside notes, and the write of a note with a rename queued still go one at a time, in order, and a notebook missing under notes sent together is made once between them. Requests that find the access token expired at the same moment now share one new token.
- Updated dependencies [62ce687]
- Updated dependencies [6fbffb5]
  - @skysa/core@0.17.0

## 0.16.0

### Minor Changes

- 89fcd18: A notebook with notebooks inside it can be opened and shut in the sidebar, by the chevron before its name or with the Right and Left arrow keys on its row. Notebooks start shut, so a large library opens as the short list of its top level, and a shut notebook's count includes every note inside it. Which notebooks are open is remembered on this device, for each source, and follows a notebook that is renamed or moved, here or on another device. The notebook open in the note list is always shown: the notebooks it is in are opened for it. While a note or notebook is being moved, resting it on a shut notebook opens it, so a destination inside one can be reached.
- 6d1123f: A note's dates come from its frontmatter in every browser. A `created` written as `2014-02-20 14:00:10 UTC`, as OneNote's exporters write it, is now read in Safari and on iPhones too, where it was taken for the day the note was imported. The date a note shows as edited is read from `updated`, or else from `modified`, `date modified` or `lastmod`, as other tools write it, or else from when the note was made, rather than being the day it was imported. Notes already imported keep the dates they were given; importing them again dates them by their frontmatter.

### Patch Changes

- 095ecfa: The chevron before a notebook that opens now starts where the text of the other lists does, and the notebooks' names move over by less to make room for it. On a touch screen its tap area reaches back to the pane's edge, so it is wider than before while the names sit closer to it.
- e8fe1bf: A note's row no longer spends its preview on a line that only says when the note was made, such as the `Thursday, February 20, 2014 2:00 PM` OneNote puts under every page's title. The preview starts with the note's own words instead. A line that says anything more than the date is kept.
- Updated dependencies [6d1123f]
  - @skysa/core@0.16.0

## 0.15.0

### Minor Changes

- 1366545: The storage panel of a Google Drive source says, behind a line that opens, that Drive lets the app see only the files it made, so notes copied into its folder on the Drive website, with Drive for desktop or by another app do not appear. The README says the same before anyone chooses a provider.
- 07032bf: Notes can be imported from a folder or from files (a `.zip`, such as the one "Download all notes" makes, or loose `.md` files), from the storage panel of the source showing. Notebooks and the files beside notes come too. Before anything is written, a question says what will come in and what stays out and why: notes that are not UTF-8 text, notes the app keeps hidden, and files over 25 MB. Nothing already in the source is changed: a taken name gets a number, and a file already there is not sent again. This is the way to bring notes into a Google Drive source, where files copied into the folder on the Drive website are invisible to the app; the Drive notice now points to it.

### Patch Changes

- Updated dependencies [07032bf]
  - @skysa/core@0.15.0

## 0.14.0

### Minor Changes

- 51f4ba2: An operator's `checkCode` may answer an accepted code with `hold`, a value the app keeps and sends in place of what was typed, for up to a year: a pass for the device, say, so a code good for minutes is typed once per device rather than once per sitting. The app never shows a held value (the gate says the code was accepted on this device, and Change opens an empty field), and asks about a held value again as it loads, at most once an hour and at once after a refused connect, keeping the answer and letting go of a value the policy refuses. A refused connect no longer drops a held value, only a typed code. An app from before this release refuses an answer that keeps a code longer than a day, so an operator should give long holds only once its app has been updated. A code, or a held value, may now be up to 256 characters. The self-hosting guide's code gate example gains the `checkCode` it needs.

### Patch Changes

- Updated dependencies [51f4ba2]
  - @skysa/core@0.14.0

## 0.13.0

### Minor Changes

- 0f89d02: Each source shows which storage it is: the provider's logo in front of its name on the tabs, in the source dropdown, and in the menu that connects another account. On a phone, the source dropdown shows the logo alone; its name is in the tooltip and is still read by a screen reader.

### Patch Changes

- @skysa/core@0.13.0

## 0.12.0

### Minor Changes

- fd9d5dc: A notebook's menu has Attached files where it holds any: each file with the notes that link it, and Delete for one no note links.
- 3ae8fe4: A picture or file taken out of a note is deleted a few minutes after the note is closed, once a sync has run since, if no note in the same storage names it then. A provider puts it in its trash. Nothing is deleted while the device may not hold every note in that storage, such as during its first import, and deleting a note still deletes none of its files.

### Patch Changes

- 17d5f49: An empty line in the rich editor is written to the note as a blank line, not as `<br />`. Two blank lines between paragraphs are one empty line in rich text, and three are two, so a note another app wrote opens with the spacing its text shows. Pressing Enter in an empty note, or at the top or end of one, no longer sends the note to markdown mode with "The rich editor has no way to show the HTML `<br />` on line 1": an empty line at the top or end of a note is written as nothing. A `<br />` already in a note is kept as written and shows in rich text, where it can be deleted. An empty task item is still written `- [ ] <br />`, since `- [ ]` alone is not a task in markdown.
- a782267: A picture tapped on a phone can be taken out of the note again. Backspace on a picture selected whole did nothing on Android, where the keyboard sends an input event rather than a key: a delete it asks for now deletes the selected picture or file chip. A selected picture also has a Remove from note button over its corner, as a chip has, for a keyboard that sends nothing at all.
- @skysa/core@0.12.0

## 0.11.1

### Patch Changes

- 8f50a08: When the rich editor keeps a note in markdown mode, the banner now always says what it found. If the editor would add something the note doesn't have, the banner says so and shows what it is, including its text, with invisible characters written out. A kind of markdown the banner has no friendly name for is named as it is, rather than as "markdown the rich editor has no way to show".
- 0a4e2e3: A note with a picture in it opens in the rich editor again. A picture with no title broke the rich editor with prosemirror-model 1.25.12, so a note was sent to markdown mode with "This note uses markdown the rich editor has no way to show" once it was opened again, or switched to markdown and back. A picture just added was shown fine until then. The workspace now resolves prosemirror-model 1.25.12 and prosemirror-view 1.42.6, so the tests run against the versions a fresh install gets.
- 898b222: The text cursor in the markdown editor is visible in dark mode again. It was drawn black on the dark background.
- Updated dependencies [8f50a08]
  - @skysa/core@0.11.1

## 0.11.0

### Minor Changes

- 38bbad8: Downloads take the files beside the notes (#187). "Download all notes" puts in every file whose current bytes this device holds, at its own path beside the notes that link it, and says how many it left out because the device holds no current copy of them; the disconnect question's download and a detached source's take the files not uploaded yet and the files the unsent notes link, and a file not uploaded yet can be downloaded on its own. The archive is written as parts straight into the blob, so a large file is never copied into one buffer, and one too big for a ZIP is refused before its bytes are read. The archive limits are told in words that name files too. "Download all notes" is offered, in the panel and the palette alike, only where the archive would hold something. A download of what was never sent that fails now says why, in the disconnect question and in a detached source's panel.
- 3ec8ccb: Files beside notes follow them between sources (#187). Connecting a source copies the device's own files into it with the notes, each owed an upload ahead of the note that links it, and a cancelled import leaves the device's files as they were. A source's own account coming back resumes its files as they were, uploads and all; one whose remote turns out to be someone else's sends again the files whose bytes this device holds. A detach keeps the files not uploaded yet, the files its kept notes link, and the files a notebook renamed here took with it. Moving unsent work to another source takes the files not uploaded yet and the files the moving notes link, where this device holds their bytes, and the confirmation says that the rest stay behind; a file not uploaded yet whose bytes are here counts as something to move on its own, and a copy owed from the remote does not. A detach that finds nothing unsent leaves no file rows behind it, and a file is never queued two uploads. While a resumed source is unchecked, a file the remote may have lost whose bytes are here counts as unsent.
- ed64ce4: A file beside a note that is not a picture shows in the rich editor as a chip with its kind and its name. Selected, it can be opened, downloaded, or removed from the note. A PDF, a picture, a recording or a film opens in a tab, and anything else is downloaded, never shown. On a phone, Download offers the share sheet.
  
  Code no longer loses a picture or a file: Code over one leaves it what it is, and a paragraph made into a code block keeps each as the markdown it is.
- f13382c: A file pasted or dropped into a note goes beside it in the note's folder, and the note links it: a picture shows as a picture, and any other file as its chip. Raw mode puts in the markdown that links it. A new note is stored when a file is added to it. A paste that carries words of its own, as one from Excel or Word does, is still pasted as words. A file over 25 MB, or a `.md` file, is refused and the reason is shown. If the note or the editor is left before a file goes in, you are told to add it again. A file dropped anywhere else in the app no longer replaces the app with that file.
- 652563f: You can choose files to put in a note in three places: the paperclip on the toolbar, Image or File in the slash menu, and "Attach files" in the command palette. The palette command works in both editors. What you choose goes beside the note and takes the place of the selection, just as a pasted file does. On a phone, Image asks for photos. Toolbar buttons that are not toggles, such as indentation and clearing formatting, are no longer announced to screen readers as "not pressed".
- 2eebe52: Pictures beside a note show in the rich editor. One that cannot be shown says why, and one larger than 8 MiB waits to be asked for. A picture pasted from Word or Outlook, which no page can load, keeps its words.
- 1332b16: The library learns files beside notes (#187). `addAttachment` adds a file to a note's folder under a content-stamped name, refusing anything over 25 MB and any `.md`, and queues its upload ahead of the note. Moving a note takes the files it links with it, copying one another note in the old notebook still links, and putting one beside a different file of the same name under a conflict name; moving a notebook moves its files ahead of its notes, and deleting one deletes them, with the count in the confirmation. A file not uploaded yet counts as unsent work when a source is disconnected, keeps its upload while the source is detached, and is forgotten with a source the user discards. A blocked sync names the op that stopped the queue rather than an upload stepped over. In the sync store, an upload that lands for a file moved or deleted meanwhile sends the `rmdir`s over it behind what it now owes, so a notebook let go during an upload does not stay on the remote. Nothing in the editor adds a file yet.

### Patch Changes

- af153ae: The app can read a file beside a note for showing it (#187), though nothing shows one yet. A file this device holds is answered from the device; any other is downloaded through the source being synced, at most two at once and once however many ask, and kept in a cache of 250 MB that lets go of the least recently used first. It never lets go of a file not uploaded yet, nor of the files of a disconnected source or of one not yet checked against its storage. A file the storage no longer has is reported as gone and left for the next sync to remove. Object URLs for showing files are shared between views and revoked a few seconds after the last one goes.
- fdeb4c9: The sync engine mirrors files that are not notes on pull (#187). Each listed file becomes a row, matched by id, or adopted from a pending row at its path of the same size; nothing is downloaded. The remote keeps the path: a pending row, or one the user moved there, steps aside under a conflict name that keeps its extension. A file the user is deleting is passed over, and one the user is moving stays where they put it. A file deleted there goes, unless the user moved it here, when it is pending again and sent from the bytes held here, or let go of at the push where none are; a file moved to a hidden path counts as deleted. Folder deletions take bound rows and keep pending ones, a note renamed into a file lets the note go and the other way round, and a scan drops the bound rows it did not find. In the web store, a file sent again is pending whether or not its bytes are held here, as the engine expects.
- fe51fa7: The sync engine pushes files that are not notes (#187). An `upload` sends a pending file's bytes, or copies them from the remote file it copies, making the folders it needs. The same file already at its name is taken for its own, unless another row holds it or a queued delete is to take it. Anything else there keeps the name, and the upload goes beside it under a conflict name that keeps its extension, chosen from one listing of the folder. A `move-file` moves a file by id, and a `delete-file` deletes one. Uploads do not hold up the queue: one that fails is counted and stepped over, then sent after everything else on later pushes; one out of attempts is kept and reported; and the outcome carries `waitingUploads`. A delete that a waiting copy still needs is held back, and so are an `rmdir` over it and an upload or move to its name. An `rmdir` leaves a notebook that still holds a file row. The web store no longer carries cached bytes to a file a move took for its own. New exports: `contentTypeOf` and `conflictFilePath`.
- cca1e62: A picture pasted, dropped or picked into a paragraph with words in it now goes in a paragraph of its own, rather than on the line beside them. A note's preview no longer runs a picture's or a file's name into the word before it.
- 3083602: A request to a storage provider is no longer given up on after a minute regardless of size: it gets 1 ms more for every 50 bytes it sends or receives — 50 KB/s, the slowest connection a file is still expected to cross — counted from the answer's `Content-Length`, or as its bytes arrive where it gives none. A note or a page of changes keeps the minute. This makes room for attachments of up to 25 MB (#187).
- 38df50c: The sync store learns files that are not notes (#187): a row per file, bound to the remote or pending upload, with its bytes kept apart and handed back only while they are still the file's. `SyncStore` gains `fileById`, `fileByPath`, `fileByRemoteId`, `allFiles`, `filesUnder` and `fileBytes`; a pull can put, move aside, delete and re-upload a file; a folder move and delete take files with them, leaving a pending one; and an upload, a file move and a lost file each have an outcome. The web app's database gains `files` and `fileBytes` tables.
- bd17b10: The formatting toolbar now works from the keyboard. Enter or Space presses the focused button, opens one of its menus, or picks from an open menu; the toolbar over a selection works the same way. Focus stays on the toolbar after a key press, so the next key does not type over your selection. A button that can't be used right now is announced as unavailable but stays reachable. The arrow keys in the link field now move the cursor within the address instead of jumping to the toolbar. A toolbar menu closes when you tab past it. Screen readers now announce the toolbar's menus as expandable panels rather than menus. A right-click on a toolbar button no longer applies it.
- Updated dependencies [7f97971]
- Updated dependencies [4697951]
- Updated dependencies [fdeb4c9]
- Updated dependencies [fe51fa7]
- Updated dependencies [cca1e62]
- Updated dependencies [c74a4f3]
- Updated dependencies [38df50c]
- Updated dependencies [1332b16]
  - @skysa/core@0.11.0

## 0.10.0

### Minor Changes

- 4b9a9d9: In a narrow window, the storage, notebook and note dropdowns at the top sit together as a path — each as wide as its name, with its chevron midway to the next — instead of in three equal thirds of the bar. A short name keeps all of its width; only the long ones are cut short, sharing what room is left. The chevron of the dropdown that is open is lit.
- 4b9a9d9: In a narrow window, choosing in one dropdown opens the next: a source chosen opens its notebooks, and a notebook its notes, so a phone goes from an account to a note in one pass. Going from one dropdown straight to another slides them along together — the one left goes off to the side and the next comes in from the other — in the order their names sit in the bar. A notebook with nothing in it still goes straight to the new note begun in it, and a user who has asked for reduced motion gets each panel at once.
- 4b9a9d9: Formatting on a phone. The formatting bar shown with `Format` stays shown on this device after a reload, until it is turned off. Its menus — the text style, `More tools`, the link field — now open over everything, including the note's title and the top bar, and are never taller than the room the keyboard leaves, scrolling inside themselves past that; with the keyboard up, the first items of `More tools` used to be cut off out of reach. And on a touch screen the floating formatting bar no longer comes up over selected text, where the system's own selection menu already does.

### Patch Changes

- 4b9a9d9: An empty list item is written as its marker alone — `-`, `2.` — instead of `- <br />`. Pressing Enter after a list item and switching to the markdown showed a `<br />` nobody had typed; and a note with an empty item in it (`-` on a line of its own) opened in the markdown editor, with the banner saying the rich editor could not show it. An empty task item still needs `- [ ] <br />`, since `- [ ]` alone is not a task.
- @skysa/core@0.10.0

## 0.9.0

### Minor Changes

- de2df01: Connecting another account covers the app with the same progress dialog as the first, until its notes have arrived. It used to open the new source straight away, empty, offering to make notebooks while the import ran. Cancel goes back to the account that was showing.

### Patch Changes

- @skysa/core@0.9.0

## 0.8.0

### Minor Changes

- 5250b0e: Disconnect signs out only the device it is pressed on. Other devices connected to the same account keep syncing, and the last device out disconnects the account and withdraws its access at the provider, as before. The disconnect question says which of the two it will be. Cancelling a first import signs out the same way. The API client's `disconnect()` is replaced by `signOut()`.
- ed3ac35: The connect gate's link ("Get a connect code") opens in the same window, as connecting storage does, instead of a new tab. In an installed app on a phone the new tab was a second window with no way back. The app opens at the code field when it is loaded with `?enter=code`, which is where an operator's page should link back to.

### Patch Changes

- 78833ed: Connecting an account again replaces the source this device still had for it under an old connection, rather than adding a second one ("Google Drive 2") beside it. "Connect again" is now a button under its message, spaced like the panel's other buttons, rather than an unstyled one wrapped against the text on a phone.
- @skysa/core@0.8.0

## 0.7.0

### Minor Changes

- 4fa2d24: The storage panel's device list names each device by its browser and system,
  "Safari on iPhone", and lists only the other devices, folded behind a count:
  "2 other devices signed in on this account". The server keeps the label, worked
  out from the User-Agent when a device connects, and never the header itself.
  
  Migration `0006_grant_device` adds a nullable `grants.device` column. Apply it
  before deploying (`wrangler d1 migrations apply`). Devices that connected before
  it show as "A device" until they next connect.

### Patch Changes

- eae2cae: A notebook's new name shows everywhere it is named as it is typed — the note
  list's heading, the bar's dropdown in a compact window and the open note's
  path — instead of after Enter. On a phone, each source's `⋯` begins with
  Rename, which turns its row into the name to type, and the dropdown above says
  the new name as it is typed.
  
  Two fixes on a phone: the menu the Sources dropdown's `+` opens is drawn over
  the list again, rather than under the rows, and `Use code` sits in the middle
  of its button.
- @skysa/core@0.7.0

## 0.6.3

### Patch Changes

- 4acb93a: Every row in the Notebooks, Notes and (on a phone) Sources lists ends in a `⋯`
  of its own, with what can be done to that notebook, note or source, so it is
  clear what the menu is about. A notebook's comes after its note count. The
  `⋯` buttons in the pane headers are gone; each header keeps its `+`.
  
  On a phone, a source that is not showing offers the same actions as the one
  that is: choosing one shows that source first, then syncs it, re-scans it,
  downloads its notes, or asks about disconnecting it in its own panel.
- @skysa/core@0.6.3

## 0.6.2

### Patch Changes

- dc4bef4: The Sources, Notebooks and Notes headers offer their choices the same way: a
  `⋯` and a `+` beside the name.
  
  - On a phone, the Sources dropdown has that header. Its `⋯` holds Sync now,
    Re-scan from scratch, Download all notes, Stop syncing on this device and
    Disconnect…, which were buttons in the panel; its `+` opens the list of
    storage providers, which was at the panel's foot. The storage panel there now
    says how syncing is going and asks what a choice needs asked.
  - The note's `Note options` menu (Move to notebook…, Delete) moves from the end
    of the note's header to beside the note list's `+`, in every window.
- @skysa/core@0.6.2

## 0.6.1

### Patch Changes

- 4d583cb: On a phone, the source, notebook and note dropdowns are their words and a
  chevron, without a box around them. The chevron points right while a dropdown
  is shut and turns down as it opens, and its panel opens out of the dropdown
  that was pressed and shuts back into it. With reduced motion asked for, the
  panel simply appears.
  
  A menu or a question opened from inside a dropdown — the notebook's `⋯`
  menu, its Delete confirmation — no longer shuts the dropdown when it is
  pressed, so Rename puts the name field where it can be typed into, rather than
  in a dropdown that has to be opened again to find it.
- 4d583cb: The note list says what is being typed as it is typed: a row's title and
  preview follow an edit to its note at the keystroke, not when autosave stores
  it two seconds later, and so does a name being typed into the name field. A
  heading typed into a note not named yet names its row as it is typed, as the
  save will name it.
- 4d583cb: A new note opens with its name selected, ready to be typed over, and Enter in
  the name moves to the text. It is stored only once something is written in it
  — a name given, or a keystroke in its text — so a note opened and left blank
  leaves no file behind. A notebook with no notes in it begins one when it opens,
  the same as `+`; the loose notes and a source still being imported do not. On
  a phone the note is what shows, not the notebooks or notes dropdown it was
  begun from.
- 4d583cb: The note list is ordered by when each note was made, newest first, rather than
  by when it was last edited, so editing a note no longer moves it to the top.
- 4d583cb: The app remembers, on this device and per source, which notebook was open and
  which note was open in each notebook, and goes back there: when it opens at its
  start URL, when a source is shown again, and when a notebook is clicked. Where
  nothing is remembered, or what was has gone, it opens the first notebook and
  its newest note — including for a notebook the app opened by itself, which
  used to show an empty pane beside its list.
- 4d583cb: Renaming a notebook changes only its name into a field: the row keeps its
  height, its highlight and its note count while the new name is typed.
- 4d583cb: A note's preview in the list, and its excerpt in search answers, are the text
  the rich editor shows — `**bold**` reads "bold", a link reads as its words
  without its URL — rather than the markdown with only its line markers removed.
  In the list, a pipe stands where one line of the note ends and the next
  begins, so two lines no longer read as one sentence.
- Updated dependencies [4d583cb]
  - @skysa/core@0.6.1

## 0.6.0

### Minor Changes

- cd742e3: The app's name, colours, icons and fonts come from a brand file read when it is
  built. Point `NOTES_BRAND` at a `brand.json` of your own to set them
  (`docs/self-hosting.md`, "Your own brand"); nothing in the repo needs editing.
  
  **Without one, the app now builds as "Notes", in gray, with the curled-page
  icons on that gray**, where it was "Skysa Notes" in blue. An instance that
  wants its old look back sets `NOTES_BRAND`. Nothing about data changes: the
  folder in storage and the local database keep their names, so connected
  libraries are found as before. The page also gets a title-bar colour for each
  of the light and dark themes, and the brand colour a dark-theme value of its
  own.

### Patch Changes

- @skysa/core@0.6.0

## 0.5.2

### Patch Changes

- 3151fa1: The storage panel's list of devices signed in to a source is a row per device,
  with what the device is on the left and Remove at the end, rather than a
  bulleted list whose Remove button sat inline after a label that wraps in a
  narrow sidebar.
- @skysa/core@0.5.2

## 0.5.1

### Patch Changes

- 89a96f4: The OAuth callback no longer strands a browser that asks for it twice. Its
  answer is kept for five minutes in a signed cookie, `skysa_flow_answer`, so the
  same callback asked for again, as after going on past a browser's warning page,
  a reload or the back button, is sent where the first was, `?connect=` outcome
  and all, and exchanges nothing. A callback with no flow of this browser's
  behind it, which was answered `flow_expired` in raw JSON, is sent back to the
  app as `?connect=expired`, and the app says that connecting did not finish and
  to connect again if the storage is not connected.
- @skysa/core@0.5.1

## 0.5.0

### Minor Changes

- 8d9c55c: A connect gate's code is checked as it is used. **Breaking** for a gate with
  `connectCode`: `createApp` now refuses one whose `EntitlementProvider` has no
  `checkCode(code)`, which answers `{ accepted: true, expiresIn }` in seconds (at
  most a day) or `{ accepted: false, reason? }`. The app asks it through the new
  `POST /api/connect-code`, which is same-origin and rate-limited as
  `connect-code:<ip>`, and the callback still decides with `check`.
  
  `connectCode` takes `required`, which leaves no way to the buttons without an
  accepted code. The gate is two steps, one open at a time. An accepted code is
  held in `localStorage` for as long as the policy said, and the gate folds to a
  line naming it until it runs out. A refusal is shown under the field, in the
  policy's words where it gave some.

### Patch Changes

- Updated dependencies [8d9c55c]
  - @skysa/core@0.5.0

## 0.4.1

### Patch Changes

- 5528228: The service worker answers a navigation with the app shell only for the app's
  own route, `/` with or without a search. Every other path on the origin goes to
  the network, so a page served beside the app, such as the one a gate's action
  links to, opens as itself rather than as the app's "Not found" in a browser
  that has run the app before.
- @skysa/core@0.4.1

## 0.4.0

### Minor Changes

- fddbb56: An operator's gate can ask for a code. `ConnectGate` takes an optional
  `connectCode: { label }`, and the app shows a field under that label where the
  gate is, in front of the provider buttons and beside them. What is typed is
  held for the tab, sent with `/start` as `connectCode` (trimmed, at most
  `MAX_CONNECT_CODE` characters), carried to the callback in the signed flow
  cookie, and handed to the policy there as `check(subject, { connectCode })`.
  `/token` never passes it. A plain refusal of a connect that carried a code reads
  "The code you entered was not accepted", and the code is dropped.

### Patch Changes

- Updated dependencies [fddbb56]
  - @skysa/core@0.4.0

## 0.3.0

### Minor Changes

- 8176135: An operator can gate connecting. `EntitlementProvider` takes an optional
  `gate` — a message and one `https:` link — which `createApp` checks when it is
  built and `/api/config` serves as `connectGate`. The app shows it where the
  provider buttons are: a device with an account syncing on the instance sees the
  buttons with the gate beside them, and any other sees the gate with an "Already
  have access? Connect storage" control that shows them.
  
  A refusal can say which kind it was: `EntitlementDecision.code` is one of
  `ENTITLEMENT_CODES` (`not_allowed`, `lapsed`, `limit_reached`), carried by the
  callback as `?connect=refused&code=…` and by `/token` beside `reason`; any other
  value is dropped. The refused toast and the storage panel word the refusal by
  it, the panel shows the operator's reason, and both offer the gate's link.
- 13f0fec: "Download all notes", in the command palette and the storage panel, saves the
  source showing as one zip of markdown: every note as the file a push would
  send, at the path it would have, and every empty notebook as a folder. On a
  device with nothing connected it is the one way to get the notes out of the
  browser. An archive past the format's limits (65,534 entries, 4 GiB) is refused
  in words rather than handed over broken.
- 25c4653: The app asks the browser to keep this device's notes
  (`navigator.storage.persist()`): once, when the first note is made in the
  device's own library, and again when the app is installed. While the browser
  has not agreed and the notes here are the only copy, the storage panel says
  the browser may clear them without warning, and that connecting storage or
  downloading them keeps them.

### Patch Changes

- Updated dependencies [8176135]
  - @skysa/core@0.3.0

## 0.2.1

### Patch Changes

- @skysa/core@0.2.1

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
