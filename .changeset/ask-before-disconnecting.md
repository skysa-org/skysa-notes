---
'@skysa/web': minor
---

Disconnecting a source now asks what should become of anything it never sent,
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
