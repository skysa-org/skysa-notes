import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No tracked text file holds a raw control byte.
 *
 * A single NUL in a `.ts` file makes git call it binary, and from then on the
 * file is absent from every diff, every blame and every three-way merge —
 * `Binary files a/… and b/… differ` is all a reviewer is shown. It reached this
 * repo twice: in `store/search.ts`, whose fingerprint separator went unreviewed
 * for two rounds because of it, and in a slug test that was asserting about
 * control characters in the first place.
 *
 * Nothing else in the gate looks at bytes. Prettier reformats the file,
 * ESLint parses it and `tsc` types it, all without complaint, because a NUL is
 * a perfectly legal character inside a string literal. Only the escape spelling
 * (as `\u0000`) keeps the file readable by the tools people review with, and
 * the two are identical once parsed.
 *
 * This lives here rather than in `packages/core` because it is about the
 * repository, not about any package, and `apps/web` is where the file that
 * prompted it lives.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Tab, newline and carriage return are the control bytes that belong in text. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/**
 * Tracked files, from git rather than a directory walk: it is git's own opinion
 * of what is in the repository, so `node_modules`, `dist` and anything else
 * ignored is already excluded, and nothing tracked is missed.
 */
const tracked = (): string[] =>
	execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 32 << 20 })
		.split('\0')
		.filter((path) => path !== '');

/**
 * Binaries are exempt by extension rather than by sniffing: the point is to
 * catch a control byte in something meant to be read as text, and a PNG is not
 * that. Anything not listed is checked, so a new kind of text file is covered
 * the day it is added.
 */
const BINARY = /\.(?:png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|wasm)$/i;

describe('every tracked text file', () => {
	it('is free of control bytes that would make git call it binary', () => {
		const offenders = tracked()
			.filter((path) => !BINARY.test(path))
			.flatMap((path) => {
				const bytes = readFileSync(join(repo, path));
				// The value, not the index: it is what the message has to name, and
				// asking for it directly is what makes it a `number` rather than a
				// `number | undefined` that only the search proves is there.
				const offender = bytes.find((byte) => byte < 0x20 && !ALLOWED.has(byte));
				// The byte in hex and where it is, because the one thing an editor
				// will not show is the character the message is about.
				return offender === undefined
					? []
					: [
							`${path}: 0x${offender.toString(16).padStart(2, '0')} at byte ${String(
								bytes.indexOf(offender)
							)}`,
						];
			});

		expect(offenders).toEqual([]);
	});
});
