# Contributing to skysa-notes

Thanks for looking. This is an early project and the most useful contributions
right now are bug reports against real use, and small focused pull requests.

Read [`docs/PLAN.md`](docs/PLAN.md) first. It is the source of truth for the
architecture, the decisions and the phase order, and it explains why a lot of
things are the shape they are. If a change needs to deviate from it, say so and
propose the edit to `docs/PLAN.md` in the same pull request.

## Getting it running

Node 22+ and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm run setup                            # writes apps/api/.dev.vars
pnpm db:migrate                            # local D1
pnpm dev                                   # Vite on :5173, wrangler dev on :8787
```

`pnpm run setup` asks which providers you want and only asks for those
credentials — the `run` matters, since `pnpm setup` is pnpm's own built-in
command. A straight copy of `.dev.vars.example` will not boot:
`ENABLED_PROVIDERS` defaults to `dropbox`, and the Worker refuses to start
without that provider's credentials rather than starting up and failing at the
first connect. Emptying `ENABLED_PROVIDERS` is not a way round it — that is a
boot failure of its own, since an API that can connect nothing is not a state
worth starting in — so the Worker needs one provider's credentials to run at
all.

You do not need it to work on most of the app. Everything that is not syncing
is in `apps/web` and runs against Vite alone (`pnpm --filter @skysa/web run
dev`): notes, notebooks, both editors, search, the palette. The Worker is only
in the picture once an account is connected.

Syncing needs your own app registration at whichever provider you are testing
(Dropbox, Microsoft Entra or Google Cloud). `pnpm run setup` asks for what it
needs and writes the file; `.dev.vars.example` documents every key if you would
rather write it by hand, and [`docs/self-hosting.md`](docs/self-hosting.md) has
the registrations in full.
Everything that does not sync runs without any of that: the app stores notes
locally and talks to nobody until a provider is connected.

## Before you open a pull request

```bash
pnpm verify   # format:check + lint + typecheck + test
```

CI runs the same thing plus `pnpm build`, and `pnpm audit --prod` for
information only. A pull request that has not run `pnpm verify` will fail, and
there is nothing in it that a maintainer can fix for you.

What is expected of a change:

- **Tests for new behaviour.** Not coverage for its own sake — a test that fails
  if the thing you fixed comes back.
- **Tick the checklist item** in `docs/PLAN.md` if the change completes one.
- **A changeset**, if the change touches `apps/` or `packages/`:
  `pnpm run changeset` asks two questions and writes a small file to commit
  alongside it. CI fails a pull request that changes a package without one. If
  the change moves nothing anyone outside the repository can observe — a test,
  a comment, a refactor — `pnpm run changeset --empty` says so, which is an
  answer rather than a way round the question. `.changeset/README.md` explains
  how a release is cut and why the three packages share one version.
- **Say why** for a new dependency, in the pull request description, and check
  the licence. Anything that reaches the shipped bundle must be MIT, Apache-2.0
  or ISC. Build- and test-time tools are held to a looser line — `docs/PLAN.md`
  §13 records what is already in the tree and why — but say which it is.
- **Check the vendor docs** rather than assuming, for anything about a provider
  API — scopes, endpoints, conflict semantics — and put the URL in a comment.

The hard rules in [`CLAUDE.md`](CLAUDE.md) apply to everyone, not just to the
assistant: `packages/core` stays framework-free, note content never reaches
`apps/api`, the markdown string is the only source of truth for a note, and no
user data is ever lost on a sync conflict.

## Commits and pull requests

Small pull requests against `main`. One concern each — a refactor bundled with a
fix makes the fix impossible to review and impossible to revert on its own.

Write the commit message for someone reading `git log` in a year: what changed
and why, not what the diff already says.

## The CLA

Every contributor signs the
[Individual Contributor License Agreement](CLA-individual.md) once — once per
person, not once per pull request. A bot comments on your first pull request
with a link and the sentence to post; signatures live in the `cla-signatures`
branch of this repository, and hold your GitHub username, your numeric GitHub
user id, the id and timestamp of the comment you signed with, and the number of
the pull request it was on. No email address, and no part of your contribution.

**It is a licence grant, not an assignment.** You keep ownership of everything
you write, and you keep the right to use your own work anywhere else, under any
terms you like. What you grant is permission for the project to use, modify,
sublicense and distribute your contribution — which is what lets the project
ship it at all, and what lets it stay relicensable if the licence ever has to
change.

In exchange, the agreement binds the project in the other direction: every
contribution stays available under AGPL-3.0, or a licence one-way compatible
with it, whatever else happens. The sublicensing right cannot be used to take
the project closed.

If you are contributing as part of your job, check whether your employer owns
what you write. If they do, they sign [`CLA-entity.md`](CLA-entity.md) instead —
it is prepared but not yet in use, so mention it on the pull request and it will
be sorted out there.

Both texts are **drafts that have not been reviewed by counsel**, and say so at
the top. They may change before they are enforced.

## Reporting a security problem

Do not open an issue. See [`SECURITY.md`](SECURITY.md).

## Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). In short: be decent, assume good
faith, and take it as read that the person you are replying to is trying.
