# 0003. Change relay

*2026-10-05. Optional, and off by default. Cited in the code as §6, "Change relay". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

A device finds another device's edits on its next poll — within 60 seconds while it is visible, sooner on focus (§7).
Where the operator turns the relay on, it finds them within a second or two, or a few on Google Drive, whose change feed trails a write (§5.1): a device that has pushed tells the API, and the API tells the connection's other devices, which pull.
It is off by default, and with it off none of this exists — `/api/config` says nothing about it and the app polls exactly as before.

- **It carries that something changed, and nothing else.**
  A device sends `{"t":"pushed"}` after a round that pushed something, and after it has sent a change to the clipboard (§7, "The clipboard"); the connection's other devices receive `{"t":"changed"}` and run an ordinary round.
  They look again 3 and 10 seconds after the last notice (`AFTER_NOTICE_MS` in `sync/scheduler.ts`, 2026-10-06), from a tab still in front: the notice comes as soon as the write is answered, and on Google Drive the round it starts at once asks the feed before the write is in it (§5.1).
  Without looking again, that round found nothing and the change waited for the poll a minute on.
  No path, no id, no version, no content.
  The note is still read from the provider, under the same version checks and conflict rule, so the relay can be wrong, late or absent and cost nothing but time.
  What it does tell the server is *when* each connection is edited, and from which device — metadata it did not have before, beyond a token refresh about once an hour.
  Nothing per message is logged.
- **Polling stays.**
  The relay hears only from this app's devices: an edit made in the folder by the provider's own client or another tool reaches nobody through it, and a socket that has dropped must not be a device that has stopped syncing.
  Every trigger in §7 stays; the relay is one more.
- **Only the source on screen.**
  The scheduler syncs one source at a time (§7), and the socket belongs to that session: opened with it, closed when it ends — a switch of source, a disconnect, the tab hidden or offline.
- **A seam, wired by the default entry.**
  `createApp({ relay })` takes a `RelayHub`: `connect(request, member)` is handed an upgrade the routes have already authorized, and `revoke(connectionId, grantIds?)` closes sockets.
  Routes see only that.
  The hub that ships is a Durable Object per connection (`ConnectionRelay`, `apps/api/src/relay/`), on the WebSocket Hibernation API so an open, idle socket costs no duration, and `src/worker.ts` passes it when `RELAY=true`.
  The binding and its migration are declared in `wrangler.toml` whether or not it is used: an object nobody addresses costs nothing, and it makes turning the relay on one variable rather than an edit to a tracked file.
  `RELAY=true` with the binding removed refuses to boot.
  A deployment that wants its fan-out elsewhere passes its own hub.
- **The credential reaches a socket without entering a URL.**
  A browser cannot set `Authorization` on a WebSocket, and `sk1_` must never appear in a URL, which logs keep.
  So the device first asks `POST /api/connection/relay/ticket` with its bearer, as for anything else under `/api/connection*`, and gets a ticket: `{ grantId, connectionId, exp }` sealed with AES-GCM under a key HKDF derives from `SECRETS_KEY` with a label of its own, as the flow cookie's HMAC key is, never the key that seals refresh tokens — opaque, good for 30 seconds, and derived from nothing the device holds.
  `GET /api/relay?ticket=…` is the upgrade.
  It is outside `/api/connection*` on purpose — every route there mounts `requireBearer`, which would refuse a request that cannot carry the header — and checks for itself, in this order: `Upgrade: websocket` (426), an `Origin` that is this app's (403 `forbidden_origin`), a ticket that opens and has not run out (401 `ticket_invalid`), a grant that is still live on that connection — the revocation and idle-expiry test `grantHolder` makes (401 `credential_revoked`) — and then the rate limiter, and then the hub.
- **How long a socket lives.**
  An hour at most: the hub closes it with `4001` the next time it would send or receive past that, and the device asks for a new ticket, which tests the grant again.
  Revoking a device or disconnecting the account closes its sockets at once with `4003`.
  All three places that null a grant tell the hub — sign-out or revoke (`DELETE /connection/grants/:id`), disconnect (`DELETE /connection`), and the cap's prune in the callback — best effort, logged on failure, never failing the request.
  A grant lost some other way, such as idle expiry, hears at most an hour more of "changed".
- **Its own throttle.**
  One `pushed` a second per socket; more are dropped.
  A frame that is not one of the two messages, or is over 256 bytes, closes the socket (`1008`).
  A ping is answered `pong` by the runtime without waking the object.
- **Deliberately not done.**
  Tickets are not single-use: that would take a table and a write per connect, and a ticket replayed inside its 30 seconds buys a socket that hears "changed" for a grant that is live anyway.
  No presence ("open on your phone"), no paths in the message, and no delivery guarantee — a missed notice is a poll away.
- **Cost (Cloudflare's published prices, 2026-10-05).**
  Two devices brought to the front twenty times a day each open about 40 sockets, each a ticket request, a Worker request and a Durable Object request; a few hundred `pushed` messages are billed at 20:1.
  Roughly 2,400 Worker requests, 1,900 Durable Object requests and a few GB-s per active user a month — about $0.0007 per user per month on Workers Paid.
  On Workers Free the cost is the daily cap instead: some 80 requests per user per day against 100k, shared with token refresh, whose failure at the cap stops sync for everyone (§13).
  That is why it is off by default, and why `docs/self-hosting.md` recommends Paid before turning it on.
- **Considered instead.**
  Provider push straight to the browser exists only on Dropbox (`list_folder/longpoll`, §5.3, still a possible later addition for that provider alone); Graph's socket.io endpoint asks for more than `Files.ReadWrite.AppFolder`, and Drive's `changes.watch` needs a public webhook.
  WebRTC between devices, signalled through files in the app folder, was designed and set aside: setting up a connection takes three trips through a poll, a phone on a carrier network often cannot be reached without a TURN relay — a server after all — and the signalling files would churn every device's change feed and sync down to the user's desktop.
