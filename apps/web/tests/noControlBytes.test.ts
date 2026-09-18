import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No source file holds a raw control byte.
 *
 * A single NUL in a `.ts` file makes git call it binary, and from then on the
 * file is absent from every diff, every blame and every three-way merge —
 * `Binary files a/… and b/… differ` is all a reviewer is shown. It reached this
 * repo twice: in `store/search.ts`, whose fingerprint separator went unreviewed
 * for two rounds because of it, and in a slug test that was asserting about
 * control characters in the first place.
 *
 * Nothing else in the gate looks at bytes. Prettier reformats the file, ESLint
 * parses it and `tsc` types it, all without complaint, because a NUL is a
 * perfectly legal character inside a string literal. Only the escape spelling
 * (as `\u0000`) keeps the file readable by the tools people review with, and the
 * two are identical once parsed.
 *
 * The tree is walked rather than `git ls-files` asked. The property is about the
 * files, and the files are right here: a walk still works from a tarball, a
 * `pnpm deploy` output (pnpm's own built-in, which copies a package's source
 * elsewhere) or a Docker build that copies source without `.git`,
 * where asking git fails the whole suite. More to the point, `git ls-files` run
 * inside a tree that some *outer* repository ignores returns nothing at all, and
 * a guard with nothing to iterate passes — silently, and for good. The canary
 * below is what makes that impossible here: the walk has to find this file.
 *
 * Git is still asked, but only to *narrow*: see `trackedOrNothing`. The walk is
 * what decides the guard is looking at anything; git's answer, when it is
 * trustworthy, is what keeps an untracked local file out of the results.
 *
 * This lives in `apps/web` rather than `packages/core` because core must run in
 * the browser and in Workers, and nothing under it may reach for `node:fs` even
 * in a test. The cost is that a repo-wide invariant is checked by one package's
 * suite; `pnpm test` runs them all (docs/PLAN.md §11).
 */

const here = fileURLToPath(import.meta.url);
const repo = join(dirname(here), '..', '..', '..');

/** Tab, newline and carriage return are the control bytes that belong in text. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** Not source: build output, dependencies, and the caches tools keep. */
const SKIP = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'coverage',
	'.wrangler',
	'.turbo',
	'.vite',
]);

/**
 * The mirror image of the bug this walk was written to fix: asking git could
 * look at nothing, and walking the tree looks at things nobody committed.
 * `.DS_Store` is the one that bites — it is in `.gitignore`, it begins with a
 * NUL, and it appears the first time anyone opens a folder in Finder, which on
 * this project's platform is the first day. `BINARY` cannot catch it: it has no
 * extension to match on.
 */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Binaries are exempt by extension rather than by sniffing: the point is to
 * catch a control byte in something meant to be read as text, and a PNG is not
 * that. The list fails open — anything unlisted is checked — so a new kind of
 * text file is covered the day it is added, at the price of one loud failure
 * the day a new kind of binary is. The message says which of the two it is.
 */
const BINARY =
	/\.(?:png|jpg|jpeg|gif|webp|avif|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|br|zst|tar|7z|mp3|mp4|m4a|mov|webm|wasm|node|docx|xlsx|pptx)$/i;

const filesUnder = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		// A symlink is followed nowhere: the file it points at is either inside
		// the walk already or outside the repository, and neither is ours.
		if (entry.isSymbolicLink()) return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : filesUnder(path);
		return entry.isFile() && !SKIP_FILES.has(entry.name) ? [path] : [];
	});

/**
 * What git tracks, or nothing when it cannot say.
 *
 * This only ever *narrows* the walk below, and that asymmetry is the whole
 * design. Asking git as the source of truth is what made the first version of
 * this guard able to pass while checking nothing: inside a tree an outer
 * repository ignores, `git ls-files` returns no paths at all. So the walk is the
 * floor — no git, no checkout, a tarball, a Docker build that copies source
 * without `.git`, and every file is still read — and git's answer is used only
 * to drop files nobody committed. A `.DS_Store` that `SKIP_FILES` does not name,
 * a scratch file someone left in `docs/`: ignored by git, so not this test's
 * business.
 *
 * The condition to trust it is that it named this file. An empty answer, an
 * answer from an outer repository that does not know this tree, or no git at
 * all, and nothing is narrowed.
 */
const trackedOrNothing = (): ReadonlySet<string> => {
	try {
		const paths = execFileSync('git', ['ls-files', '-z'], {
			cwd: repo,
			encoding: 'utf8',
			maxBuffer: 32 << 20,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.split('\0')
			.filter((path) => path !== '')
			.map((path) => join(repo, path));
		return new Set(paths.includes(here) ? paths : []);
	} catch {
		return new Set();
	}
};

const sources = (): string[] => [
	// The root's own files — `package.json`, the workspace and lockfiles, the
	// dotfiles — but not the directories beside them, which are named next.
	...readdirSync(repo, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !SKIP_FILES.has(entry.name))
		.map((entry) => join(repo, entry.name)),
	// Named rather than "everything but SKIP", which is what would let the
	// ignored and the untracked back in. `.github` is here because a workflow
	// file breaks blame and review exactly as a source file does, and
	// `.changeset` because its files are hand-written prose that ends up in a
	// changelog — which is this guard's own case, not an extension of it.
	...['apps', 'packages', 'docs', '.github', '.changeset'].flatMap((dir) =>
		filesUnder(join(repo, dir))
	),
];

describe('every source file', () => {
	it('is free of control bytes that would make git call it binary', () => {
		const walked = sources();
		const tracked = trackedOrNothing();
		const files = tracked.size === 0 ? walked : walked.filter((path) => tracked.has(path));

		// The canary. A walk that found nothing would pass the assertion below
		// while checking nothing at all, which is the failure mode worth guarding
		// against: a guard that has quietly stopped looking is worse than none,
		// because it is the one you stop thinking about.
		expect(files).toContain(here);

		const offenders = files
			.filter((path) => !BINARY.test(path))
			.flatMap((path) => {
				const bytes = readFileSync(path);
				// The value, not the index: asking for it directly is what makes it
				// a `number` rather than a `number | undefined` that only the search
				// proves is there. `indexOf` then agrees with `find` — nothing
				// before the first match satisfies the predicate, so nothing before
				// it holds this value either.
				const offender = bytes.find((byte) => byte < 0x20 && !ALLOWED.has(byte));
				// The byte in hex and where it is, because the one thing an editor
				// will not show is the character the message is about. And what to
				// do about it, because the right action depends on which kind of
				// file this is, and only the person who added it knows.
				return offender === undefined
					? []
					: [
							`${relative(repo, path)}: 0x${offender
								.toString(16)
								.padStart(2, '0')} at byte ${String(bytes.indexOf(offender))} — ` +
								'escape it (\\u0000 and friends); or, if this file is not text, ' +
								'add its extension to BINARY, or its name to SKIP_FILES when it ' +
								'is a local file nobody commits',
						];
			});

		expect(offenders).toEqual([]);
	});
});
