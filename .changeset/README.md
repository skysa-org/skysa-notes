# Changesets

A changeset is a note, written with the change and merged with it, saying what
moved and how much. `pnpm run changeset` asks two questions and writes one here.

```
pnpm run changeset            # write one
pnpm run changeset:status     # what is pending, and what it would release
pnpm run changeset:version    # consume them: bump versions, write CHANGELOGs
```

## What is unusual here, and why

**One version, not three.** `@skysa/core`, `@skysa/web` and `@skysa/api` are
`fixed` together, so they always carry the same number. They are not three
libraries — they are one deployment, and a web bundle that does not match the
Worker it talks to is not a thing this repository ever produces. That shared
number is what the `vX.Y.Z` tag names.

**Nothing is published.** All four packages are `private`, and
`changeset publish` is never run: the release is a Cloudflare deploy, and the
tag exists so that a deployed instance can be traced to a commit. The version
is not cosmetic either way — `apps/web/vite.config.ts` reads it into
`APP_VERSION`, which is written into the marker file in the user's own storage.

**Versioning is a local step, not a bot.** `pnpm run changeset:version` is run
by hand, reviewed as a pull request like anything else, and merged. Pushing it
to `main` is what makes `.github/workflows/release.yml` cut the tag. The
Changesets "Version Packages" bot is deliberately not used: a pull request
opened with `GITHUB_TOKEN` starts no workflows, so its own CI would never run,
and once `verify` is a required check such a pull request could never merge.

## When to write one

Whenever a pull request changes anything under `apps/` or `packages/`. CI asks
for it and will fail the pull request without one.

When the change genuinely does not move the version — a test, a comment, a
refactor nobody outside the repository can observe — say that rather than
inventing a bump:

```
pnpm run changeset --empty
```

That writes a changeset with no packages in it, which is a real answer and
leaves a record that the question was asked.

## Which bump

Pre-1.0, so the usual semver contract does not apply yet and the question is
about how much a reader should care.

- **patch** — a fix, or anything invisible from outside.
- **minor** — a feature, a new command, a provider, a schema migration.
- **major** — reserved. Nothing here takes one before 1.0.

The summary is read by people deciding whether to upgrade an instance they run.
Write it for them: what changed for a user, not which function was renamed.
