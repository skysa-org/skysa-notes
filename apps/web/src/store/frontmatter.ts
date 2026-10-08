import { type NoteFrontmatter, readFrontmatter } from '@skysa/core';

import { keptAnswers, roomFor } from './kept.js';

/**
 * A note's frontmatter, read once per block (#275).
 *
 * `readFrontmatter` is a YAML parse, and the scratchpad asked it of every card
 * on every draw: whether the card is named (`isUnnamed`), and its pin and
 * colour (`scratchMarks`). A scratchpad is drawn again on every write to the
 * notes table — every autosave of every note — and a wall of six hundred
 * cards was some two and a half thousand parses each time: the marks were
 * asked three times a card, and a cache of 400 missed every one of them past
 * 400 cards. (Now a card's block is read for its pin only if it says `pinned`,
 * `scratchGroups`, and for the rest as the card is drawn or its height
 * guessed.) A block is a string, so the same one asked again is a lookup, and one
 * edited is a new key rather than a stale entry.
 *
 * Kept for as many rows as the lists have shown (`store/kept.ts`), the least
 * recently asked out first: a bound under the cards drawn is no cache, since
 * drawing the wall again asks for every card in the order the last draw put
 * them out. What is kept is shared, so it is frozen.
 */

const LIMIT = 400;

const NONE: Readonly<NoteFrontmatter> = Object.freeze({});

/** Frozen, tags and all: every card asking about the same block is handed the one answer. */
const frozen = (read: NoteFrontmatter): Readonly<NoteFrontmatter> => {
	if (read.tags !== undefined) Object.freeze(read.tags);
	return Object.freeze(read);
};

const kept = keptAnswers<Readonly<NoteFrontmatter>>(() => roomFor(LIMIT));

/** What `frontmatter` says, as `readFrontmatter` reads it. */
export const frontmatterOf = (frontmatter: string | null): Readonly<NoteFrontmatter> =>
	frontmatter === null ? NONE : kept(frontmatter, (block) => frozen(readFrontmatter(block)));
