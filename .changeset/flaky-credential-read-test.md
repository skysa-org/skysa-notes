---
---

Nothing ships in this change: one test is made to stop failing at random.

The test for a failure that never left the device refused the credential once,
and the panel is not its only reader — a reconcile and the token source ask for
the same one — so whichever asked first took the refusal and the click's own
read succeeded. It failed about a third of the time. It now refuses for as long
as the click is being answered, and gives the credential back as soon as the
message is on screen.
