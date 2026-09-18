import { describe, expect, it } from 'vitest';

import { EMPTY_QUERY, type FindQuery, locate, matchesIn } from '../src/editor/find.js';

/**
 * The engine both editors share. What is worth pinning is the behaviour the two
 * halves would otherwise each invent — word boundaries, case folding, an
 * expression that is not valid yet — because a bar whose count changes when the
 * user switches modes is worse than two separate bars.
 */

const query = (search: string, extra: Partial<FindQuery> = {}): FindQuery => ({
	...EMPTY_QUERY,
	search,
	...extra,
});

const found = (text: string, q: FindQuery): readonly string[] =>
	matchesIn(text, q).map((match) => `${String(match.from)}-${String(match.to)}`);

describe('matchesIn', () => {
	it('finds every occurrence, in order', () => {
		expect(found('one two one', query('one'))).toEqual(['0-3', '8-11']);
	});

	it('ignores case unless asked', () => {
		expect(matchesIn('One one ONE', query('one'))).toHaveLength(3);
		expect(matchesIn('One one ONE', query('one', { caseSensitive: true }))).toHaveLength(1);
	});

	it('takes whole words only when asked', () => {
		expect(matchesIn('cat cats scat', query('cat'))).toHaveLength(3);
		expect(found('cat cats scat', query('cat', { wholeWord: true }))).toEqual(['0-3']);
	});

	it('reads the search as a regular expression only when asked', () => {
		expect(matchesIn('a.c abc', query('a.c'))).toHaveLength(1);
		expect(matchesIn('a.c abc', query('a.c', { regexp: true }))).toHaveLength(2);
	});

	/**
	 * A regular expression is typed one character at a time, and most of those
	 * are not yet valid. Throwing would take the bar down mid-word.
	 */
	it('matches nothing for a regular expression that is not valid', () => {
		expect(matchesIn('anything', query('(unclosed', { regexp: true }))).toEqual([]);
	});

	/**
	 * The case that took the raw editor down. CodeMirror refuses an empty mark
	 * decoration by throwing, and it throws from inside the update cycle *after*
	 * the new state is committed — so every later update threw too and typing in
	 * the note stopped working, until the component was remounted. `a*`, `\d*`,
	 * `^` and `x?` are all ordinary things to type into a regular-expression
	 * find box.
	 */
	it('drops a match of nothing', () => {
		expect(matchesIn('banana', query('a*', { regexp: true }))).toEqual([
			{ from: 1, to: 2 },
			{ from: 3, to: 4 },
			{ from: 5, to: 6 },
		]);
		expect(matchesIn('one\ntwo', query('$', { regexp: true }))).toEqual([]);
		expect(matchesIn('anything', query('x?', { regexp: true }))).toEqual([]);
	});

	it('has nothing to find for an empty search', () => {
		expect(matchesIn('some text', query(''))).toEqual([]);
	});

	it('counts offsets across lines the way the text runs', () => {
		expect(found('one\ntwo\none', query('one'))).toEqual(['0-3', '8-11']);
	});
});

describe('locate', () => {
	const matches = [
		{ from: 0, to: 3 },
		{ from: 8, to: 11 },
		{ from: 20, to: 23 },
	];

	it('says nothing is current when nothing matches', () => {
		expect(locate([], { from: 0, to: 0 })).toEqual({ total: 0, current: null });
	});

	/** After a `next` the selection *is* a match, and the counter should hold. */
	it('names the match the selection already is', () => {
		expect(locate(matches, { from: 8, to: 11 })).toEqual({ total: 3, current: 2 });
	});

	it('names the next match ahead of a cursor between two', () => {
		expect(locate(matches, { from: 5, to: 5 })).toEqual({ total: 3, current: 2 });
	});

	/** Past the last one, the next `next` wraps to the first — so it reads as 1. */
	it('wraps round when the cursor is past the last match', () => {
		expect(locate(matches, { from: 40, to: 40 })).toEqual({ total: 3, current: 1 });
	});
});
