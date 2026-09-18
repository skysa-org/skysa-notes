# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's **private vulnerability reporting** on this repository:
[Security → Report a vulnerability](https://github.com/skysa-org/skysa-notes/security/advisories/new).
It creates a private advisory only the maintainers can see.

If that page says reporting is not enabled, it has not been switched on yet —
it is a repository setting, and turning it on is on the maintainer's list. In
that case please open an issue saying only *"I have a security report and
private reporting is off"*, with no detail of the problem in it, and you will
be given somewhere private to send it.

Please include, as far as you can:

- what an attacker gets, in one sentence
- the steps to reproduce it, or a proof of concept
- which version or commit you tested
- whether it needs a user to be signed in, and whose

You will get an acknowledgement as soon as the maintainer sees it, usually
within a week. This is a small project with one maintainer and no paging, so
that is an expectation rather than a promise, and it is about answering rather
than fixing; the advisory thread is where a timeline gets agreed.

You are welcome to disclose publicly once a fix has shipped, or after 90 days,
whichever is sooner. Say so in the report if you want to coordinate on a date.

## Supported versions

There are no releases yet. Only `main` is supported; fixes land there. Anyone
self-hosting is running their own deployment of some commit, so **the security
of your instance is the security of the commit you deployed**, and updating is
on you. Versioning and release tags arrive in Phase 8 (`docs/PLAN.md` §10).

## What is in scope

This repository: `apps/web` (the PWA), `apps/api` (the Cloudflare Worker), and
`packages/core`.

Things that are especially worth looking at, because they are where the
interesting properties live:

- **Credentials.** A device proves its right to a connection with a credential
  it generated; the server stores only its SHA-256. Anything that gets a
  credential's plaintext out of the browser, or lets a credential for one
  connection act on another, is a serious finding. `docs/PLAN.md` §6,
  "Per-connection credentials", sets out the model.
- **The content security policy.** `script-src 'self'` with nothing inline is
  load-bearing, not a nicety: it is what stops an XSS from exfiltrating a
  credential that `httpOnly` cannot protect. A way around it is a finding even
  without a script injection to go with it.
- **Refresh tokens.** They exist only encrypted in D1 and never leave the
  server. Anything that returns one, logs one, or decrypts one without the
  right credential is a serious finding.
- **Note content reaching the server.** By design it never does. If you find a
  path where it does, that is a bug regardless of whether it is exploitable.
- **The OAuth flow**: `state`, the PKCE verifier, the flow cookie, the
  `returnTo` redirect, and the same-origin check on `/start`.

## What is out of scope

- **Self-inflicted deployment problems**: a missing `SECRETS_KEY`, an
  `APP_ORIGIN` that does not match, secrets committed to your own fork,
  provider app registrations with over-broad scopes.
  [`docs/self-hosting.md`](docs/self-hosting.md) covers the setup; a
  misconfiguration is not a vulnerability in the code.
- **Anything requiring an attacker to already have the user's device unlocked**,
  or their storage provider account. Notes are in IndexedDB by design, in plain
  text, because the app works offline; that is the product, not a bug.
- **Denial of service by volume** against your own instance. Rate limiting is a
  seam an operator fills (`createApp({ rateLimiter })`), deliberately, so that
  no one deployment's policy is baked into the repo.
- **Missing headers with no exploit path**, automated scanner output pasted
  without a scenario, and reports about dependencies that do not reach the
  shipped bundle.

## A note on the threat model

The server is deliberately not trusted with note content and never sees it. It
*is* trusted with refresh tokens, which are the keys to a user's app folder. A
compromise of a deployment's `SECRETS_KEY` plus its D1 database is total for
every connected account on that instance — that is understood and stated rather
than mitigated away, and it is why operators are told to treat both as secrets
of the same weight.
