<!--
Small pull requests against `main`, one concern each. A refactor bundled with a
fix makes the fix impossible to review and impossible to revert on its own.

CONTRIBUTING.md has the rest. Delete any heading below that does not apply
rather than writing "n/a" under it.
-->

## What this changes, and why

<!-- What a reader of `git log` needs in a year. Not what the diff already says. -->

## How it was verified

<!--
`pnpm verify` is the floor, not the answer. What did you actually do to find
out this works — and, for a fix, what fails without it?
-->

- [ ] `pnpm verify` passes (format, lint, typecheck, tests)
- [ ] Tests cover the new behaviour, and fail without the change
- [ ] `docs/ARCHITECTURE.md` amended in this pull request if the change alters a decision recorded there

## Anything else

<!--
New dependency? Say why, and its licence — MIT, Apache-2.0 or ISC only.
Provider API detail? Link the vendor doc you checked, and put the URL in a comment.
Something you are unsure about? Say so here; it is more useful than a clean
description that hides it.
-->
