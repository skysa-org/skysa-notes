---
'@skysa/web': minor
'@skysa/core': minor
---

On an instance that runs the change relay, the app holds a socket to it for the source on screen, while the app is in front of the user and online. A device that has just pushed says so, and the connection's other devices sync within a second or two instead of at their next poll. Polling goes on as before, and an instance without a relay is never asked for a ticket: the app asks `/api/config` first. The socket closes when the tab is hidden, goes offline, switches source or is disconnected. It reconnects with backoff after a failure, at once when its hour is up, and never after the device has been signed out.

`@skysa/core` now exports the relay's wire protocol, so the two ends cannot drift: its two messages, its keep-alive, its close codes and its throttle.
