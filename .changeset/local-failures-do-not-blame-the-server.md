---
'@skysa/web': patch
---

The storage panel no longer tells you to check a connection that was never
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
