# 0002. Getting a library out

*2026-09-24. Cited in the code as §7, "Getting a library out". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**"Download all notes" writes the source showing as one zip of markdown**, from the palette (`app.download`) or the storage panel.
It reverses §14 for export only (issue #133).
That entry said export mattered more when the store was the only copy of anything, and for a device with nothing connected the store still is: no provider client to zip its folder, no other device to open it on, and nothing between it and a browser clearing its storage.
For a source that syncs it is what this device holds of the folder — its notes and the files beside them it has read, not one not yet pulled — without a trip to the provider's client, which costs nothing to offer, so it is offered there too.

The archive is the one the disconnect download already made (`store/exportNotes.ts`): each live note as `noteFile`, the bytes a push would send, at the path it would have, under `entryName`'s zip-slip-safe names with duplicates numbered.
So it is the tree a push would make in the provider folder, and unpacking it into a newly connected account's folder gives the same notes back — which is why import needs no feature of its own.
One addition: **an empty notebook is an entry of its own** (`name/`, no bytes, the MS-DOS directory attribute).
A folder with a note in it is implied by the note's path; an empty one has nothing to imply it, and would be the one thing the user made that the archive did not give back.
It takes its name before any file does, as every implied folder already did, so a file clashing with it is the numbered one.
With no empty notebooks the bytes are exactly what they were.

The editors write what they are holding before the source is read (`settleEditors`), as they do before a disconnect's list: the store alone would leave out the sentence typed a second ago.
Where an editor holds text the store would not take, the archive is made anyway and the user is told it lacks that text — a download destroys nothing, unlike the discard that refuses in the same position.
A stored ZIP without ZIP64 stops at 65,534 entries and 4 GiB; `zipOf` refuses from there with an `ArchiveLimitError` naming which limit, and the user is told in words (`downloadProblem`) rather than handed a file that will not open.
The panel's button and the palette's command are both held back while a later source's first import is filling it, when the archive would be whatever part had arrived; the panel's also while the disconnect question is open, which has a download of its own.

**Files (2026-10-03, #187).**
The files beside the notes go in where this device holds their bytes as they are now (`heldBytesAreCurrent`), each at its own path, so the notes' relative links find them once it is unpacked; after the notes, so a clash of names numbers the file.
A file the remote has that this device has never read, or holds only in an older version, is left out and counted, and the user is told how many and that the source's storage still has them (`downloadNotice`, after the text an editor could not save, which only the user can rescue).
A file row carries no date, so its entry is stamped with the export's.
The archive is built as parts (`zipParts`) handed to the `Blob` as they are, so a 25 MB picture is never copied into a buffer the size of the archive; `zipOf` is the same parts joined, for a reader.
An archive past the 4 GB a stored ZIP can address is refused before a byte is read, from the sizes the rows give for the files whose bytes are held (`refuseOversize`): `zipParts` would refuse it too, but only once all of it was in memory.
A source offers a download (`holdsAnything`, which the panel and the palette both go by) when it has a notebook, a live note, or a file whose current bytes are here; a file row alone would be an empty archive.
The disconnect question's download and a detached source's (`downloadUnsent`) take the unsent notes, the files not uploaded yet, and the files those notes link, where their bytes are here.
A listed file goes in as whatever bytes are here, stale or not, since a listed bound file is one an unchecked resume may hold the only copy of; a file only linked goes in only as the remote has it now.
What they leave out is the remote's, or a copy to be made of the remote's, and is said nowhere: nothing of the user's is missing from it.
A file not uploaded yet is something to download on its own (`hasUnsentDownload`).
A download from either that fails says why beside the button that asked (`downloadProblem`), since a user who thinks they have a copy is one who goes on to discard.
