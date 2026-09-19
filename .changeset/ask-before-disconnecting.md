---
'@skysa/web': minor
---

Disconnecting a source now asks what should become of anything it never sent,
before anything happens — and can move it to another connected source.

Pressing Disconnect saves whatever the editor is still holding, sends one last
push where that has any chance of working, and then asks. Nothing is said to
the server until you answer, so cancelling changes nothing anywhere. If the
account has everything, it is the plain confirm it always was. If it does not,
the question says how much has not reached it and cannot once it is
disconnected, names the notes (five, with the rest behind "and N more") and
counts the renames, deletes and notebooks, and says why they cannot be sent
right now when you are offline or a change has been refused too many times.
Cancel is the button that has the focus, Escape closes, and a note whose text
could not be saved yet stops the question being answered at all until you have
copied it out.

The answers are to move it, download it, discard it by name, or cancel.
**Move** takes the notes the account never had in full, and the notebooks they
are in, into another source you have connected — named on the button, chosen
from a list where you have more than one — and uploads them there as new
notes. A second step says what will be in each account afterwards: a note the
old account already had in an older version stays there as well, and a rename
or a delete you made but never sent is not carried across, because each is
about a file only the old account has. That same Move is now on a disconnected
source's own panel, beside Reconnect, Download and Discard.

As with Discard, a move reaches only what you were shown: a note written into
after the list appeared is kept where it is, and the source stays on the device
around it. Undoing a delete after a move puts the note back in the source its
notes were moved to, and an editor left open on a moved note follows it there.
