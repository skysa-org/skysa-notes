---
'@skysa/api': minor
---

`createApp` takes an optional `relay`, a `RelayHub`, for the change relay (docs/ARCHITECTURE.md §6, "Change relay"). With one, `/api/config` says `relay: true`, a device holding a connection can ask `POST /api/connection/relay/ticket` for a 30-second ticket, and `GET /api/relay?ticket=…` hands a same-origin WebSocket upgrade to the hub. Before that, the upgrade checks the ticket and that its grant is still live. Signing a device out, revoking one, disconnecting and the grant cap's eviction each tell the hub to close the sockets that went with them. Without a hub, which is the default, nothing changes and both routes answer 404.
