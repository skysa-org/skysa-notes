---
'@skysa/web': patch
---

The storage panel no longer tells you to check a connection that was never
used.

Disconnecting, connecting and removing a device are each a few writes on this
device around one call to our server, and until now any failure of any of them
was reported as the server's: "the server cannot be reached". That was plainly
wrong for "Stop syncing on this device", which asks the server nothing at all —
a store that refused a write there sent you to look at your connection, and
offered you a server to try again. Each of the three now says which half failed,
because the code that made the call says so rather than guessing from the error,
and a failure it cannot place claims nothing about where it happened.
