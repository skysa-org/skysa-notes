# @skysa/api

## 0.21.1

### Patch Changes

- Updated dependencies [7c4541b]
  - @skysa/core@0.21.1

## 0.21.0

### Patch Changes

- @skysa/core@0.21.0

## 0.20.3

### Patch Changes

- @skysa/core@0.20.3

## 0.20.2

### Patch Changes

- @skysa/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [3eaa0b5]
  - @skysa/core@0.20.1

## 0.20.0

### Patch Changes

- @skysa/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [1fe2319]
  - @skysa/core@0.19.0

## 0.18.2

### Patch Changes

- @skysa/core@0.18.2

## 0.18.1

### Patch Changes

- @skysa/core@0.18.1

## 0.18.0

### Minor Changes

- 90fe489: The change relay can be turned on: `RELAY = "true"` in `wrangler.toml`'s `[vars]`. Its hub is a Durable Object per connection, `ConnectionRelay`, bound as `RELAY_HUB`. It is declared in `wrangler.toml` whether or not the relay is on, and it costs nothing while nobody addresses it. With the relay on, a device that has pushed tells the connection's other devices, which then sync within a second or two. Read docs/self-hosting.md, "Instant updates between devices", first: the server learns when each connection is edited, and on Workers Free the relay spends the request cap that token refresh shares.
  
  **For an operator with a Worker entry of their own:** it must now `export { ConnectionRelay }`, from `@skysa/api/relay` outside `apps/api/src`, because `wrangler.toml` binds that class and a deploy whose entry does not export it is refused. `RELAY = "true"` without the binding refuses to boot.
- 8d385c7: `createApp` takes an optional `relay`, a `RelayHub`, for the change relay (docs/ARCHITECTURE.md §6, "Change relay"). With one, `/api/config` says `relay: true`, a device holding a connection can ask `POST /api/connection/relay/ticket` for a 30-second ticket, and `GET /api/relay?ticket=…` hands a same-origin WebSocket upgrade to the hub. Before that, the upgrade checks the ticket and that its grant is still live. Signing a device out, revoking one, disconnecting and the grant cap's eviction each tell the hub to close the sockets that went with them. Without a hub, which is the default, nothing changes and both routes answer 404.

### Patch Changes

- Updated dependencies [d555ebc]
  - @skysa/core@0.18.0

## 0.17.1

### Patch Changes

- Updated dependencies [bca2080]
  - @skysa/core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [62ce687]
- Updated dependencies [6fbffb5]
  - @skysa/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [6d1123f]
  - @skysa/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [07032bf]
  - @skysa/core@0.15.0

## 0.14.0

### Minor Changes

- 51f4ba2: An operator's `checkCode` may answer an accepted code with `hold`, a value the app keeps and sends in place of what was typed, for up to a year: a pass for the device, say, so a code good for minutes is typed once per device rather than once per sitting. The app never shows a held value (the gate says the code was accepted on this device, and Change opens an empty field), and asks about a held value again as it loads, at most once an hour and at once after a refused connect, keeping the answer and letting go of a value the policy refuses. A refused connect no longer drops a held value, only a typed code. An app from before this release refuses an answer that keeps a code longer than a day, so an operator should give long holds only once its app has been updated. A code, or a held value, may now be up to 256 characters. The self-hosting guide's code gate example gains the `checkCode` it needs.

### Patch Changes

- Updated dependencies [51f4ba2]
  - @skysa/core@0.14.0

## 0.13.0

### Patch Changes

- @skysa/core@0.13.0

## 0.12.0

### Patch Changes

- @skysa/core@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [8f50a08]
  - @skysa/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [7f97971]
- Updated dependencies [4697951]
- Updated dependencies [fdeb4c9]
- Updated dependencies [fe51fa7]
- Updated dependencies [cca1e62]
- Updated dependencies [c74a4f3]
- Updated dependencies [38df50c]
- Updated dependencies [1332b16]
  - @skysa/core@0.11.0

## 0.10.0

### Patch Changes

- @skysa/core@0.10.0

## 0.9.0

### Patch Changes

- @skysa/core@0.9.0

## 0.8.0

### Patch Changes

- 88872bf: A device is named from the app's own request to start connecting, not from the browser's return from the provider. A Chrome on a Mac whose User-Agent was rewritten for Google's pages was listed as "Safari on iPhone".
- @skysa/core@0.8.0

## 0.7.0

### Minor Changes

- 4fa2d24: The storage panel's device list names each device by its browser and system,
  "Safari on iPhone", and lists only the other devices, folded behind a count:
  "2 other devices signed in on this account". The server keeps the label, worked
  out from the User-Agent when a device connects, and never the header itself.
  
  Migration `0006_grant_device` adds a nullable `grants.device` column. Apply it
  before deploying (`wrangler d1 migrations apply`). Devices that connected before
  it show as "A device" until they next connect.

### Patch Changes

- @skysa/core@0.7.0

## 0.6.3

### Patch Changes

- @skysa/core@0.6.3

## 0.6.2

### Patch Changes

- @skysa/core@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [4d583cb]
  - @skysa/core@0.6.1

## 0.6.0

### Patch Changes

- @skysa/core@0.6.0

## 0.5.2

### Patch Changes

- @skysa/core@0.5.2

## 0.5.1

### Patch Changes

- 89a96f4: The OAuth callback no longer strands a browser that asks for it twice. Its
  answer is kept for five minutes in a signed cookie, `skysa_flow_answer`, so the
  same callback asked for again, as after going on past a browser's warning page,
  a reload or the back button, is sent where the first was, `?connect=` outcome
  and all, and exchanges nothing. A callback with no flow of this browser's
  behind it, which was answered `flow_expired` in raw JSON, is sent back to the
  app as `?connect=expired`, and the app says that connecting did not finish and
  to connect again if the storage is not connected.
- @skysa/core@0.5.1

## 0.5.0

### Minor Changes

- 8d9c55c: A connect gate's code is checked as it is used. **Breaking** for a gate with
  `connectCode`: `createApp` now refuses one whose `EntitlementProvider` has no
  `checkCode(code)`, which answers `{ accepted: true, expiresIn }` in seconds (at
  most a day) or `{ accepted: false, reason? }`. The app asks it through the new
  `POST /api/connect-code`, which is same-origin and rate-limited as
  `connect-code:<ip>`, and the callback still decides with `check`.
  
  `connectCode` takes `required`, which leaves no way to the buttons without an
  accepted code. The gate is two steps, one open at a time. An accepted code is
  held in `localStorage` for as long as the policy said, and the gate folds to a
  line naming it until it runs out. A refusal is shown under the field, in the
  policy's words where it gave some.

### Patch Changes

- Updated dependencies [8d9c55c]
  - @skysa/core@0.5.0

## 0.4.1

### Patch Changes

- @skysa/core@0.4.1

## 0.4.0

### Minor Changes

- fddbb56: An operator's gate can ask for a code. `ConnectGate` takes an optional
  `connectCode: { label }`, and the app shows a field under that label where the
  gate is, in front of the provider buttons and beside them. What is typed is
  held for the tab, sent with `/start` as `connectCode` (trimmed, at most
  `MAX_CONNECT_CODE` characters), carried to the callback in the signed flow
  cookie, and handed to the policy there as `check(subject, { connectCode })`.
  `/token` never passes it. A plain refusal of a connect that carried a code reads
  "The code you entered was not accepted", and the code is dropped.

### Patch Changes

- Updated dependencies [fddbb56]
  - @skysa/core@0.4.0

## 0.3.0

### Minor Changes

- 8176135: An operator can gate connecting. `EntitlementProvider` takes an optional
  `gate` — a message and one `https:` link — which `createApp` checks when it is
  built and `/api/config` serves as `connectGate`. The app shows it where the
  provider buttons are: a device with an account syncing on the instance sees the
  buttons with the gate beside them, and any other sees the gate with an "Already
  have access? Connect storage" control that shows them.
  
  A refusal can say which kind it was: `EntitlementDecision.code` is one of
  `ENTITLEMENT_CODES` (`not_allowed`, `lapsed`, `limit_reached`), carried by the
  callback as `?connect=refused&code=…` and by `/token` beside `reason`; any other
  value is dropped. The refused toast and the storage panel word the refusal by
  it, the panel shows the operator's reason, and both offer the gate's link.

### Patch Changes

- Updated dependencies [8176135]
  - @skysa/core@0.3.0

## 0.2.1

### Patch Changes

- 977583b: `parseEnv` and `AppConfig` are exported from the package entry beside
  `createApp`, so an operator writing their own Worker entry can build its
  config through the same validation the default entry uses.
- @skysa/core@0.2.1

## 0.2.0

### Minor Changes

- c228479: An operator's `EntitlementProvider` is asked at the OAuth callback as well as at
  `/api/token`, before anything is stored. An account it refuses no longer leaves
  a refresh token sealed in the database: nothing is stored, the consent just
  given is withdrawn where the provider has a call for it, and the app says the
  account cannot sync on this server. For operators: `EntitlementSubject`'s
  `connectionId` is now optional, and is absent when the account is connecting
  for the first time.
- b568603: "Connect again" now signs out the credential the device held before, so it no
  longer lingers in the device list for 180 days as a device that is not one and
  a live key to the account.
  
  On the server, revoking the last live device of an account disconnects it: the
  row is deleted and the grant withdrawn at the provider where there is a call
  for it, rather than being left as a live refresh token nothing can reach or
  revoke. `DELETE /api/connection/grants/:id` answers `disconnected` (and
  `revoked` when it is) alongside `ok`. The web app's device list only removes
  *other* devices, so this is reached through the API; an account whose only
  device clears its site data is still not cleaned up.

### Patch Changes

- cc724cb: Sign-in separate from storage is dropped rather than deferred: identity and
  storage are coupled, so a person is their storage account.
  
  Two things a user or an operator can see. The refusal for
  `AUTH_MODE=account-first` now says the mode is not implemented **and will not
  be**, rather than "not implemented yet" — a decision rather than a schedule.
  And the client stops carrying three connect outcomes the server retired in
  Phase 7: `conflict`, `occupied`, and `signin`, which rendered "Sign in before
  connecting storage" for a product that does not exist. A stale link carrying
  one of them used to render an empty red banner; now it renders nothing.
- Updated dependencies [751d856]
- Updated dependencies [74e5bc6]
- Updated dependencies [c228479]
- Updated dependencies [480405f]
- Updated dependencies [30a5c70]
- Updated dependencies [ba48ecc]
- Updated dependencies [15f05a4]
- Updated dependencies [8bb745f]
- Updated dependencies [470c58e]
- Updated dependencies [ceb0e5f]
- Updated dependencies [1fdbf29]
- Updated dependencies [c2a0296]
- Updated dependencies [4ca6bad]
- Updated dependencies [0b73ab7]
- Updated dependencies [7d827cf]
  - @skysa/core@0.2.0
