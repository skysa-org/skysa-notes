# @skysa/api

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
