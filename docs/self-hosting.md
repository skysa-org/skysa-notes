# Self-hosting skysa-notes

Everything in this repository is meant to run on your own Cloudflare account.
There is no hosted instance to fall back to and nothing withheld from the open
source: `wrangler.toml` carries placeholders, `.dev.vars.example` lists every
key, and no operator-specific behaviour exists outside the seams `docs/PLAN.md`
§6 describes.

Budget about fifteen minutes, plus however long the provider app registration
takes — Dropbox is minutes, Google is the longest.

> **Two things about the commands below.** They are all run **from the
> repository root** — `wrangler` is a dependency of `apps/api` and not of the
> root, which is why they reach it as `pnpm --filter @skysa/api exec wrangler`
> rather than by changing directory; run `pnpm run deploy` from inside
> `apps/api` and you get that package's own `deploy`, which is not the one you
> want. And it is **`pnpm run setup`, not `pnpm setup`**: both `setup` and
> `deploy` are pnpm's own built-in commands, so the `run` is required or pnpm
> does something else entirely.

## What you need

- A **Cloudflare account**. Workers Free is enough indefinitely for personal
  use; see [Cost](#cost) before running an instance for other people.
- **Node 22+ and pnpm 10** (`corepack enable`).
- **An app registration at each storage provider you want to offer.** Every
  OAuth provider needs its own; there is no way around this, and it is why
  `ENABLED_PROVIDERS` defaults to just `dropbox`.
- A **domain** on Cloudflare, if you want something other than
  `<worker>.<subdomain>.workers.dev`.

## 1. Clone and configure

```bash
git clone https://github.com/skysa-org/skysa-notes.git
cd skysa-notes
pnpm install
pnpm run setup        # asks for what it needs, writes apps/api/.dev.vars
```

`pnpm run setup` asks which providers you want and only asks for the credentials
of those. That is not politeness: listing a provider in `ENABLED_PROVIDERS`
commits the deployment to having its credentials, and the Worker **refuses to
boot** without them rather than starting up and failing at the first connect.

It also generates `SECRETS_KEY` — 32 random bytes, base64 — wherever `openssl`
is on the path, and tells you how to generate one yourself where it is not. A
value that does not decode to exactly 32 bytes is refused at boot.

It will not write a file the Worker would refuse to boot from. An empty answer
to a required key, or to all three providers, is asked again rather than
written down.

You can write `apps/api/.dev.vars` by hand instead. Copy `.dev.vars.example`,
which documents every key including the exact redirect URI, scopes and account
types each provider wants.

## 2. Register the provider apps

The full instructions for each live in
[`.dev.vars.example`](../.dev.vars.example) next to the key they fill in, so
they cannot drift from the code that reads them. In summary:

| Provider | Where | The thing people get wrong |
|---|---|---|
| **Dropbox** | App Console → Scoped access, App folder | The app name is **immutable** and must be `skysa-notes` |
| **OneDrive** | Entra app registration | Platform is **Web**, not SPA — the exchange happens on the server, with the secret |
| **Google Drive** | Cloud console → OAuth client, Web application | Testing status caps you at 100 test users and expires refresh tokens after 7 days |

Each redirect URI is `<APP_ORIGIN>/api/auth/connect/<provider>/callback`, so
they all change when you move from `http://localhost:5173` to your real domain.
Register both if you want to keep developing against the same app.

Google is involved enough to have its own walk-through, including leaving
Testing status without needing verification:
[`docs/google-oauth.md`](google-oauth.md).

## 3. Run it locally first

```bash
pnpm db:migrate       # create and migrate the local D1 database
pnpm dev              # Vite on :5173, wrangler dev on :8787
```

Vite proxies `/api` to the Worker so the app and the API share an origin, which
is what production does too — one Worker serves both.

Connect an account and create a note. If it syncs here, the only things left
that can be wrong in production are the origin, the secrets and the database.

## 4. Create the D1 database

```bash
pnpm --filter @skysa/api exec wrangler login
pnpm --filter @skysa/api exec wrangler d1 create skysa-notes
```

That prints a `database_id`. Put it in `apps/api/wrangler.toml`, replacing the
placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "skysa-notes"
database_id = "paste-it-here"
```

This is the one edit to a tracked file that self-hosting requires. It is not a
secret — it names a database only your account can reach.

## 5. Set the secrets

`.dev.vars` is for local development and is gitignored. A deployed Worker reads
secrets from Cloudflare, so set each one:

```bash
w() { pnpm --filter @skysa/api exec wrangler "$@"; }

w secret put APP_ORIGIN               # https://notes.example.com
w secret put SECRETS_KEY
w secret put DROPBOX_CLIENT_ID
w secret put DROPBOX_CLIENT_SECRET
# …and the pair for each other provider in ENABLED_PROVIDERS
```

**`APP_ORIGIN` has no default and the Worker will not boot without it.** That is
deliberate: every OAuth redirect URI is derived from it, and a wrong guess sends
users' consent to somewhere that is not you.

`AUTH_MODE`, `ENABLED_PROVIDERS` and `WEBDAV_ALLOW_PRIVATE` are not secrets and
live in `[vars]` in `wrangler.toml`. Edit them there.

`SECRETS_KEY_ID` defaults to `k1` and only needs setting when you rotate
`SECRETS_KEY`, which is what it exists for. `MICROSOFT_TENANT` defaults to
`common` and only needs setting for a single-tenant Entra registration — and it
has to be set as a secret like the rest, because `wrangler.toml` has no `[vars]`
entry for it.

Treat `SECRETS_KEY` with the same weight as the database itself: it is what
encrypts every stored refresh token, and whoever holds both holds every
connected account on the instance.

## 6. Deploy

```bash
pnpm --filter @skysa/api exec wrangler d1 migrations apply skysa-notes --remote
pnpm run deploy
```

`pnpm run deploy` builds the core package, then the web bundle, then the Worker,
then deploys. The order matters, and so does being at the repository root:
`apps/api`'s own `deploy` script is also called `deploy` and does not build the
SPA, so reaching that one — by running it from inside `apps/api` — ships
whatever stale `apps/web/dist` happens to be lying around, or nothing at all.

For a custom domain, add a route in the Cloudflare dashboard (Workers → your
Worker → Settings → Domains & Routes), then make `APP_ORIGIN` match it exactly,
scheme and all, and add the matching redirect URIs at each provider.

Migrations are separate from deploys on purpose. `pnpm --filter @skysa/api run
deploy:migrate` does both in order when you want them together.

## 7. Check it

- The app loads and creates notes offline.
- Connecting an account redirects to the provider and comes back to
  `?connect=ok`.
- A note appears in the app folder in your storage within a few seconds.
- `wrangler tail` shows no errors. Note content never appears in the logs,
  because it never reaches the Worker at all.

## Cost

Workers Free is enough for one person indefinitely. The Worker is only involved
in connecting an account and in minting access tokens — never in reading or
writing a note, which goes straight from the browser to the storage provider —
so a browser costs it tens of requests a day rather than thousands, against a
100k/day limit. Static assets are free and unlimited on both plans.

Running an instance for other people, two things to know:

- **Free hard-stops at 100k requests/day until 00:00 UTC**, which would break
  token refresh for every user at once. Workers Paid bills per request instead,
  lifts the CPU limit, extends logs to 7 days and enables Logpush.
  `wrangler.toml` already sets `limits.cpu_ms = 50` to cap runaway cost; it is
  harmless on Free.
- **Back up D1.** `wrangler d1 export` on a cron trigger. The database holds
  encrypted refresh tokens and connection metadata — never note content, which
  is in the user's own storage and their browser.

Pricing verified 2026-09; check Cloudflare's own pages before relying on it.

## Updating

```bash
git pull
pnpm install
pnpm --filter @skysa/api exec wrangler d1 migrations apply skysa-notes --remote
pnpm run deploy
```

There are no release tags yet, so `main` is what you get and the security of
your instance is the security of the commit you deployed. See
[`SECURITY.md`](../SECURITY.md).

## When it will not boot

The Worker refuses to start rather than starting up wrong. Every failure is
reported as `Invalid environment:` followed by one line per problem — all of
them, not just the first. The three that catch people:

| The line | What to do |
|---|---|
| `APP_ORIGIN: Invalid input: expected string, received undefined` | No default exists; set it. (`Invalid URL` instead means it is set but malformed — the scheme is what is usually missing.) |
| `SECRETS_KEY: SECRETS_KEY must be base64 of exactly 32 bytes` | Regenerate: `openssl rand -base64 32` |
| `DROPBOX_CLIENT_SECRET: required because ENABLED_PROVIDERS includes "dropbox"` | Register that provider's app, or drop it from `ENABLED_PROVIDERS` |

`AUTH_MODE=account-first` is refused the same way — *"account-first is not
implemented yet"*. It is Phase 9 and is not built; accepting it would leave you
believing connections were gated behind a sign-in when they were not.
