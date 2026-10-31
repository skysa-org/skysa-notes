# 0008. The clipboard

*2026-10-06. Cited in the code as §7, "The clipboard". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**A clipboard a source's devices share.**
Turned on per device and per source from the storage menu ("Show clipboard", on the gear and the source's `⋯`), it is a full-width region of its own just before the storage panel, ruled off above it, at the foot of the sidebar or of a compact window's source dropdown (`components/clipboard/ClipboardPanel.tsx`; it was inside the panel, above the status line, until 2026-10-06).
Holding anything, it takes its featured form: a gradient tinted with the brand's colour, an edge in that colour drawn inside it, and a glow outside it.
While files are dragged over the window its edge thickens and it glows more, and most with them over it.
The edge only ever grows inward, so neither the region's width nor its items move.
An item not yet sent is greyed out under a spinner until it is up, and "Copied" or "Saved" is shown over the item it is about, and announced, rather than under the list; what went wrong is still said under the list, being longer than an item has room for.
Things come in by Paste, which reads the browser's clipboard; by a keyboard paste in the region, or a drop anywhere in the window (below); by "Add a file"; and, on Android and ChromeOS, from the system's share sheet (§8, "Shared to the app").
Pressing an item puts text or a picture back on the clipboard.
A file is saved, because no browser lets a page put a file on the clipboard.
A source with nothing connected has no clipboard, and neither does a detached one or one whose first import is still filling it.
The items are files in `.clipboard/` at the root of the app folder (§3).

**The whole window takes a drop for it (2026-10-14, the owner's choice).**
Files had to be dropped on the region itself, a small target at the foot of the sidebar, and one not on screen at all in a compact window, where it is in the source dropdown.
While the clipboard is shown, a file dropped anywhere in the window is added to it (`useWindowDrop` in `ClipboardPanel`), but in two places.
On a note's text, which takes a dropped file into the note (`attachDrop.ts`) as it always has, by the owner's choice over the clipboard taking every drop; and on a dialog, a drop behind which is taken by nothing.
The drag is caught on the way down, at the window, before anything under the pointer, and the editors are told apart as the drop guard tells them (`inEditor` in `useFileDropGuard.ts`), which then finds the drop taken and stands aside.
While files are dragged where a drop would come here, the window says so over itself: an edge around it in the brand's colour and "Drop to add to clipboard" at its foot, out of the region, which is mounted in a compact window's dropdown, shut.
Over a note's text neither shows.

**Not the library.**
Clips have tables of their own, `clips` and `clipBytes`, and are never rows in `files`.
Folded into `files` they would be counted as unsent, exported, cleaned up as files no note links and evicted by the cache's budget, and every one of those would be wrong.
The engine passes over `.clipboard/` as it passes over any hidden path.
All it says of the folder is that a pull met it (`SyncOutcome.clipboard`, carried by a round and a scan page alike, the folder's own entry included, since a folder deleted whole is reported without what was in it), or may have: a deletion that comes by id alone counts too (2026-10-06).
On Google Drive and OneDrive a change's path comes from the tree the adapter keeps from the feed (§5.1, §5.2), and an item this device pasted is not in that tree until the feed reports it back.
Removed on another device before then, it reaches this one as an id and nothing else.
Uncounted, the device that pasted it was the one device that kept showing it, since its feed had moved past the only change that would ever name it.
Counted, it costs one listing where the clipboard is shown, also for the rare note or file deleted the same way.

**Every paste is local first** (`addClips` in `store/clipboard.ts`).
It is a `pending` row with its bytes at once, offline too, and the list on screen is the one the folder is about to have: a paste of what is already there drops the older item, and past 10 the oldest go.
Such an item is deleted outright if it is pending, and otherwise marked `removing` until its delete is sent.
Each write checks, inside its transaction, that the source is still live.
Anything over 25 MB is refused, a file by its size before its bytes are read.

**Sending and fetching** (`sync/clipboard.ts`, through the session the scheduler runs, one job at a time per source).
`flush` uploads each pending item, making the folder if it is missing.
It takes a name already there at that size as its own upload, whose answer was lost.
It deletes each `removing` item, and tells the relay once if anything moved (§6).
It waits for a run in flight first: Dropbox takes one write at a time.
`refresh` lists the folder and reconciles: a new name is a `sent` row, a row whose name is gone goes, and a pending row whose name is there is sent.
Then it fetches the bytes of text and pictures it lacks, two at a time.
A file's bytes are fetched only when it is saved, and a file's own bytes are let go of once it is up.
The scheduler starts both when a session starts, starts `flush` after every round, and starts `refresh` after a round whose pull met the folder, while the clipboard is shown, and again 3 s later (`RELIST_MS`): Drive's search goes on listing a file for a moment after it is trashed (§5.1), and a listing taken then keeps the item, with nothing to ask again since the feed has moved on.
None of it holds the status on "syncing".

**What follows from that.**
- **With the relay off**, another device finds a paste at its next poll, the way it finds an edit.
- **Drive deletes to its trash**, so an item let go of stays in the user's Drive trash until it is emptied.
- **The cap keeps the folder small.**
  Every provider's change feed reports each item that comes and goes to every device, hidden or not, so ten is also all a pull ever has to pass over there.
- **On this device only.**
  Turning it off hides the region and stops refreshing.
  The items stay in the folder and in the tables.
- **Dropped with the source.**
  Letting a source go (disconnect, detach, or a reconnect's bind taking over a detached row) deletes its clips, their bytes and their thumbs, pending ones included.
  A clip is a copy of what the user pasted, not something written in the library, and a detached source has no remote to send it to.
  A detached source's row loses `clipboard`, so a reconnect starts with it hidden.

**Pictures drawn from thumbs (2026-10-08, #276).**
The panel draws a picture 6rem tall, so it draws it from a thumb (`components/clipboard/clipPictures.ts`), made on this device from the item's bytes and kept in `clipThumbs`, beside the item and gone with it: removed, pushed out by newer ones, let go of by another device, or written over there (a thumb made from bytes read as an older version is not kept).
Its URL and its turn are kept by the item's version as well as its name, as a picture beside a note's are by its file's (`urlKey`): a picture written over elsewhere keeps its name, and under its name alone it would be drawn from the old picture's URL, still held for its five seconds' grace, or from the work on the old bytes.
Once the bytes and thumb have gone, the panel draws the icon and forgets the URL it had, which may be revoked by the time they are back.
Thumbs wait their turn in the same order as a note's copies and the scratch cards' (`copyTurns`), so one original at a time is read for any of them.
What the panel watches is whether the bytes or the thumb are here, by key.
It held each item's whole bytes in a live query to draw it, ten photos' worth at once.
Some pictures are still drawn from their bytes as they are, and that is kept said: one a thumb would barely shrink, one that moves, one whose header says nothing the app reads, and one the browser could not make a thumb of.
A thumb missed, or not kept on a full device, is asked for again the next time.
The bytes are still fetched as they come (the owner's choice): a picture is pasted whole, and the panel is where it is pasted from.
