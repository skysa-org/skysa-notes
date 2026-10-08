import { type NoteFrontmatter, readFrontmatter } from '@skysa/core';

import { roomFor } from './kept.js';

/**
 * A note's frontmatter, read once per block (#275).
 *
 * `readFrontmatter` is a YAML parse, and the scratchpad asks it of every card
 * on every draw: whether the card is named (`isUnnamed`), and its pin and
 * colour (`scratchMarks`). A scratchpad is drawn again on every write to the
 * notes table — every autosave of every note — so a wall of six hundred cards
 * was six hundred parses and more each time. A block is a string, so the same
 * one asked again is a lookup, and one edited is a new key rather than a stale
 * entry.
 *
 * Kept for as many rows as the lists have shown (`store/kept.ts`), the least
 * recently asked out first: a bound under the cards drawn is no cache, since
 * drawing the wall again asks for every card in the order the last draw put
 * them out. What is kept is shared, so it is never to be changed.
 */

const LIMIT = 400;

const NONE: Readonly<NoteFrontmatter> = Object.freeze({});

const read = new Map<string, Readonly<NoteFrontmatter>>();

/** What `frontmatter` says, as `readFrontmatter` reads it. */
export const frontmatterOf = (frontmatter: string | null): Readonly<NoteFrontmatter> => {
	if (frontmatter === null) return NONE;
	const known = read.get(frontmatter);
	if (known !== undefined) {
		// To the back of the queue: asked again, so kept longest.
		read.delete(frontmatter);
		read.set(frontmatter, known);
		return known;
	}
	const answer = readFrontmatter(frontmatter);
	read.set(frontmatter, answer);
	if (read.size > roomFor(LIMIT)) {
		const oldest = read.keys().next();
		if (oldest.done !== true) read.delete(oldest.value);
	}
	return answer;
};
