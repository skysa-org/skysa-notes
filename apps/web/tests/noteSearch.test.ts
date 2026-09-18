import { describe, expect, it } from 'vitest';

import { type NoteRecord } from '../src/store/db.js';
import { createNoteSearch, type NoteHit, SEARCH_LIMIT } from '../src/store/search.js';

/**
 * Search is the one place the app answers a question about *every* note rather
 * than the one that is open, so what matters is what it finds, what it leaves
 * out, and that it says where in the note the answer was.
 *
 * `store/search.ts` never reads the database — it is handed rows — so these are
 * plain objects, and the wiring to Dexie is tested where it lives.
 */

const note = (fields: Partial<NoteRecord> & Pick<NoteRecord, 'id' | 'body'>): NoteRecord => ({
	connectionId: 'local',
	path: `${fields.id}.md`,
	title: fields.id,
	frontmatter: null,
	tags: [],
	// Anything that changes the body changes this, which is what tells the index
	// a row it already holds has moved on.
	contentHash: `hash-of-${fields.body}`,
	dirty: 0,
	deletedLocally: 0,
	createdAt: 0,
	updatedAt: 0,
	...fields,
});

const found = (hits: readonly NoteHit[]): string[] => hits.map((hit) => hit.note.id);

const text = (hit: NoteHit | undefined): string =>
	(hit?.excerpt ?? []).map((run) => run.text).join('');

const marked = (hit: NoteHit | undefined): string[] =>
	(hit?.excerpt ?? []).filter((run) => run.hit).map((run) => run.text);

describe('finding a note', () => {
	const search = createNoteSearch();
	search.refresh([
		note({ id: 'compost', title: 'Compost', body: 'Turn the heap every second week.' }),
		note({ id: 'sourdough', title: 'Sourdough', body: 'Feed the starter every week.' }),
		note({ id: 'tagged', title: 'Roof', body: 'Nothing about plants.', tags: ['garden'] }),
	]);

	it('matches a word in the middle of a body, which no key index would', () => {
		expect(found(search.find('starter'))).toEqual(['sourdough']);
	});

	it('matches a word the user has only started typing', () => {
		expect(found(search.find('comp'))).toEqual(['compost']);
	});

	it('matches through a typo', () => {
		expect(found(search.find('sourdogh'))).toEqual(['sourdough']);
	});

	it('matches a tag, which is on the note and not in its body', () => {
		expect(found(search.find('garden'))).toEqual(['tagged']);
	});

	it('narrows on a second word rather than widening', () => {
		// Both notes hold "every week"; only one holds "heap".
		expect(found(search.find('every week')).length).toBe(2);
		expect(found(search.find('heap week'))).toEqual(['compost']);
	});

	it('narrows on a second word of one letter, like any other second word', () => {
		// The one-letter rule is about pieces of a word the tokenizer broke up,
		// not about short words: "plan b" is two words, and dropping the `b`
		// made it return exactly what "plan" returns.
		const plans = createNoteSearch();
		plans.refresh([
			note({ id: 'planB', title: 'Plan B', body: 'the other one' }),
			note({ id: 'planA', title: 'Plan A', body: 'the first one' }),
			note({ id: 'planning', title: 'Planning', body: 'how it is done' }),
		]);

		expect(found(plans.find('plan b'))).toEqual(['planB']);
	});

	it('searches for a word of one character beside another word', () => {
		// The same rule, where a single character is a whole word: dropping it
		// puts every note with the other word back in the answer.
		const cjk = createNoteSearch();
		cjk.refresh([
			note({ id: 'both', title: '\u6c34 tea', body: 'about water and tea' }),
			note({ id: 'teaOnly', title: 'tea only', body: 'about tea' }),
		]);

		expect(found(cjk.find('\u6c34 tea'))).toEqual(['both']);
	});

	it('asks a chunk that is nothing but single letters as it was written', () => {
		// "a-b" is two one-letter pieces and nothing else. Dropping both asks
		// for nothing at all, which is worse than asking for what was typed.
		const dashes = createNoteSearch();
		dashes.refresh([
			note({ id: 'hasIt', title: 'Sizes', body: 'the a-b comparison' }),
			note({ id: 'not', title: 'Other', body: 'nothing of the sort' }),
		]);

		expect(found(dashes.find('a-b'))).toEqual(['hasIt']);
	});

	it('finds nothing for a query that is not there', () => {
		expect(found(search.find('bicycle'))).toEqual([]);
	});

	it('finds nothing for an empty query, rather than everything', () => {
		expect(found(search.find(''))).toEqual([]);
		expect(found(search.find('   '))).toEqual([]);
	});

	it('takes a query made only of punctuation without falling over', () => {
		expect(found(search.find('(*)'))).toEqual([]);
	});

	it('ranks a title above a body', () => {
		const ranked = createNoteSearch();
		ranked.refresh([
			note({ id: 'inTheBody', title: 'Elsewhere', body: 'A passing mention of compost.' }),
			note({ id: 'inTheTitle', title: 'Compost', body: 'Nothing else at all.' }),
		]);

		expect(found(ranked.find('compost'))[0]).toBe('inTheTitle');
	});

	it('ranks a tag above a word buried in a body', () => {
		// The weights: a tag was put on the note deliberately, and a body that
		// happens to say the word twice should not outrank it.
		const ranked = createNoteSearch();
		ranked.refresh([
			note({
				id: 'inTheBody',
				title: 'Elsewhere',
				body: 'A long note about compost, which mentions compost twice.',
			}),
			note({ id: 'onTheTag', title: 'Roof', body: 'Nothing about it.', tags: ['compost'] }),
		]);

		expect(found(ranked.find('compost'))[0]).toBe('onTheTag');
	});

	it('hands back what the pane shows, and one more to say there are more', () => {
		// A short query can match everything there is, and every hit costs an
		// excerpt walked over a whole body and a row rendered, per keystroke.
		// The extra one is how the pane tells a list it cut short from a list
		// that is exactly full.
		const many = createNoteSearch();
		many.refresh(
			Array.from({ length: 60 }, (__, at) =>
				note({ id: `n${String(at)}`, body: 'compost heap' })
			)
		);

		expect(many.find('compost')).toHaveLength(SEARCH_LIMIT + 1);
	});

	it('hands back exactly what there is when there are no more than that', () => {
		const exactly = createNoteSearch();
		exactly.refresh(
			Array.from({ length: SEARCH_LIMIT }, (__, at) =>
				note({ id: `n${String(at)}`, body: 'compost heap' })
			)
		);

		expect(exactly.find('compost')).toHaveLength(SEARCH_LIMIT);
	});

	it('puts the most recently edited first where the query cannot tell them apart', () => {
		const tied = createNoteSearch();
		tied.refresh([
			note({ id: 'older', title: 'Compost', body: 'Same words.', updatedAt: 1 }),
			note({ id: 'newer', title: 'Compost', body: 'Same words.', updatedAt: 2 }),
		]);

		expect(found(tied.find('compost'))).toEqual(['newer', 'older']);
	});
});

describe('keeping up with the store', () => {
	it('finds a note added since the last refresh', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'first', body: 'hello' })]);
		search.refresh([
			note({ id: 'first', body: 'hello' }),
			note({ id: 'second', body: 'world' }),
		]);

		expect(found(search.find('world'))).toEqual(['second']);
	});

	it('forgets a note that is no longer among them', () => {
		const search = createNoteSearch();
		search.refresh([
			note({ id: 'first', body: 'hello' }),
			note({ id: 'second', body: 'world' }),
		]);
		search.refresh([note({ id: 'first', body: 'hello' })]);

		expect(found(search.find('world'))).toEqual([]);
	});

	it('follows an edit: the new words are found and the old ones are not', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', body: 'about herons' })]);
		search.refresh([note({ id: 'n', body: 'about kingfishers' })]);

		expect(found(search.find('kingfishers'))).toEqual(['n']);
		expect(found(search.find('herons'))).toEqual([]);
	});

	it('follows a rename, which changes the title and not a word of the body', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', title: 'Draft', body: 'unchanged' })]);
		search.refresh([
			note({ id: 'n', title: 'Invoice', path: 'Invoice.md', body: 'unchanged' }),
		]);

		expect(found(search.find('invoice'))).toEqual(['n']);
		expect(found(search.find('draft'))).toEqual([]);
	});

	it('hands back the row as it stands now, not as it was indexed', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', body: 'unchanged', dirty: 0 })]);
		// An edit elsewhere in the row: the same words, so the index has nothing
		// to do, but the results are drawn with what the row says.
		search.refresh([note({ id: 'n', body: 'unchanged', dirty: 1 })]);

		expect(search.find('unchanged')[0]?.note.dirty).toBe(1);
	});
});

describe('the excerpt', () => {
	const around = (body: string, query: string): NoteHit | undefined => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', title: 'Note', body })]);
		return search.find(query)[0];
	};

	it('is one line, whatever the markdown did', () => {
		const hit = around('# Heading\n\n- one\n- two\n\nthe heron stood still', 'heron');

		expect(text(hit)).toContain('one two the heron stood still');
		// The hashes and bullets are gone: they are line markers, and this is
		// one line.
		expect(text(hit)).not.toMatch(/[#-]/);
	});

	it('marks the word that matched', () => {
		expect(marked(around('the heron stood still', 'heron'))).toEqual(['heron']);
	});

	it('marks the word in the note, not the word that was typed', () => {
		// The point of marking MiniSearch's terms: a prefix query matched a
		// longer word, and marking what was typed would leave it unmarked.
		expect(marked(around('the kingfisher waited', 'kingf'))).toEqual(['kingfisher']);
	});

	it('marks every place the word appears in the line, not only the first', () => {
		expect(marked(around('heron, and another heron', 'heron'))).toEqual(['heron', 'heron']);
	});

	it('marks a match whatever its case', () => {
		expect(marked(around('The Heron stood still', 'heron'))).toEqual(['Heron']);
	});

	it('keeps the match near the front, where the column has not clipped yet', () => {
		// The excerpt is read in a column a little over forty characters wide.
		// Forty characters of run-up put the highlight at or past where that
		// clips — every test green, and the one thing the row is for off screen.
		// So the run-up is short, and this is the assertion that says so.
		const filler = 'padding words before it. '.repeat(20);
		const hit = around(`${filler}the heron stood still`, 'heron');
		const runs = hit?.excerpt ?? [];
		const leading = runs
			.slice(
				0,
				runs.findIndex((run) => run.hit)
			)
			.map((run) => run.text)
			.join('');

		expect(marked(hit)).toEqual(['heron']);
		expect(leading.length).toBeLessThanOrEqual(25);
	});

	it('centres the line on the match rather than starting at the note', () => {
		const filler = 'padding '.repeat(60);
		const hit = around(`${filler}the heron stood still`, 'heron');

		expect(text(hit)).toContain('heron');
		expect(text(hit).startsWith('…')).toBe(true);
		expect(marked(hit)).toEqual(['heron']);
	});

	it('says at both ends that there is more note than this', () => {
		const filler = 'padding '.repeat(60);
		const hit = around(`${filler}heron${filler}`, 'heron');

		expect(text(hit).startsWith('…')).toBe(true);
		expect(text(hit).endsWith('…')).toBe(true);
	});

	it('does not claim there is more when the whole note is shown', () => {
		const hit = around('the heron stood still', 'heron');
		expect(text(hit)).toBe('the heron stood still');
	});

	it('falls back to the start of the note when the match is in the title alone', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', title: 'Herons', body: 'nothing of the kind here' })]);

		const hit = search.find('herons')[0];
		expect(text(hit)).toBe('nothing of the kind here');
		expect(marked(hit)).toEqual([]);
	});

	it('is empty for a note with no body at all', () => {
		const search = createNoteSearch();
		search.refresh([note({ id: 'n', title: 'Empty', body: '' })]);

		expect(text(search.find('empty')[0])).toBe('');
	});

	it('takes a note whose text reads as a regular expression literally', () => {
		// Escaping: unescaped, `a+b` and `(a lot)` are syntax, and the excerpt is
		// either wrong or the regex throws.
		const hit = around('costs $9 (a lot) [see: a+b]', 'a+b');
		expect(text(hit)).toContain('$9 (a lot) [see: a+b]');
	});

	it('marks the whole word, not the shorter match inside it', () => {
		// The alternation takes the first branch that matches, so `meet|meeting`
		// against "meeting" marks `meet` and leaves the rest of the word plain —
		// the very thing marking MiniSearch's terms is meant to avoid.
		expect(marked(around('meet the meeting about meetings', 'meet'))).toEqual([
			'meet',
			'meeting',
			'meetings',
		]);
	});

	it('marks words, not runs of letters inside them', () => {
		// `he` is in "the" and in "there". A box around those is noise the user
		// has to read past to find the match.
		expect(marked(around('he said the heron was there', 'he'))).toEqual(['he', 'heron']);
	});

	it('does not mark the letters a punctuated word is tokenized into', () => {
		// MiniSearch splits on punctuation, so "don't" arrives as `don` and a
		// bare `t`, and marking the `t` paints a box round half the line.
		const hit = around("don't touch the thermostat at all", "don't");

		expect(marked(hit)).toEqual(['don']);
	});

	it('does not cut a character in half at the end of the window', () => {
		// The window is measured in UTF-16 units and an emoji takes two of them.
		// This one is placed to straddle the cut exactly: without the guard the
		// excerpt ends in a lone high surrogate, which renders as `\uFFFD`.
		const hit = around(`heron ${'y'.repeat(173)}\u{1F426} and more`, 'heron');

		expect(text(hit)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(text(hit)).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});
});
