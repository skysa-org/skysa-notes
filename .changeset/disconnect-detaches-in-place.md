---
'@skysa/web': minor
---

Disconnecting a source no longer leaves its notes in a pile on the device that
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
