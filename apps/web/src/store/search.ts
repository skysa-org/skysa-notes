import { previewText } from '@skysa/core';
import MiniSearch from 'minisearch';

import { type NoteRecord } from './db.js';

/**
 * Full-text search over the notes this device holds, and nothing else: no
 * request, no provider API, no server index. The notes are already here — that
 * is what local-first means — so search has to work in a tunnel like the rest of
 * the app (docs/PLAN.md §7).
 *
 * Not a Dexie query. IndexedDB indexes whole keys and their prefixes, so it can
 * find a note whose title *starts with* what was typed and nothing else: a word
 * in the middle of a body is invisible to it, and scanning every row for a
 * substring would still rank nothing and miss "meetings" for "meeting". So the
 * words are indexed in memory, by MiniSearch, from the rows the caller reads.
 *
 * Note the split of responsibilities: this module never touches the database.
 * It is handed every note the user can see and told to make the index agree with
 * them. That is what lets the caller decide *when* — the app builds an index
 * only while a search is open, and drops it when the search closes, rather than
 * carrying one for a feature nobody is using (docs/PLAN.md §7).
 *
 * Not `routes/search.ts`, which is the query string.
 */

/** The fields worth matching on. `tags` is a list on the row and a line here. */
interface Indexed {
	readonly id: string;
	readonly title: string;
	readonly tags: string;
	readonly body: string;
}

const indexed = (note: NoteRecord): Indexed => ({
	id: note.id,
	title: note.title,
	tags: note.tags.join(' '),
	body: note.body,
});

/**
 * What the index holds of a note, as a string to compare against. A row whose
 * fingerprint has not moved is left in place: re-indexing every note on every
 * keystroke would cost the whole corpus each time the autosave fires.
 *
 * `contentHash` is the one that decides: it covers the body and the frontmatter
 * the tags and the title come from, and every writer that changes any of them
 * recomputes it. Path and title are named beside it as a belt and braces, not
 * because they are needed today — they cost two string comparisons, and they are
 * what would catch a future writer that moved one without the other.
 *
 * The separator is written as an escape and must stay one. A literal NUL in the
 * source makes git call this file binary: it then never appears in a diff, a
 * blame or a three-way merge, and nothing in the gate — prettier, eslint, tsc —
 * objects. `tests/noControlBytes.test.ts` is what keeps that true.
 */
const fingerprint = (note: NoteRecord): string =>
	`${note.contentHash}\u0000${note.path}\u0000${note.title}`;

/** A run of the excerpt, `hit` where it is what the query matched. */
export interface Excerpt {
	readonly text: string;
	readonly hit: boolean;
}

export interface NoteHit {
	readonly note: NoteRecord;
	/** One line of the body around the first match, or the start of it. */
	readonly excerpt: readonly Excerpt[];
}

/**
 * The most matches the pane shows. A search is for finding one note, and a list
 * nobody scrolls to the end of costs an excerpt and a row per note per
 * keystroke.
 *
 * `find` hands back one more than this, and the pane shows this many: the extra
 * one is how a list that was cut short is told apart from a list that is exactly
 * this long, so the pane can say "there are more" only when there are.
 */
export const SEARCH_LIMIT = 50;

export interface NoteSearch {
	/**
	 * Make the index agree with these notes: whatever is not among them is
	 * forgotten, whatever has changed is indexed again.
	 */
	readonly refresh: (notes: readonly NoteRecord[]) => void;
	/**
	 * Best first, at most `SEARCH_LIMIT + 1` of them. An empty or
	 * all-punctuation query matches nothing.
	 */
	readonly find: (query: string) => NoteHit[];
}

/**
 * The tokenizer, which has to be the one the corpus was indexed with: a query
 * cut by a different rule asks for terms that were never made. It is taken from
 * MiniSearch's defaults, which is the same thing only because the index above
 * passes no `tokenize` of its own — give it one and this has to be given the
 * same one.
 */
const tokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[];

/**
 * The words of a query, as the words to ask about.
 *
 * The tokenizer does not split on everything — "a+b" is one term to it, and so
 * is "$9" — which is why it has to be asked rather than guessed at.
 *
 * What is dropped is a one-letter piece of a word *the tokenizer itself broke
 * up*: the `t` of "don't", the `e` of "e-mail". Those are letters nobody typed
 * as a word, and with prefix matching on, one letter matches most of the notes
 * there are and most of the words inside them, which the excerpt then marks.
 *
 * The chunk the user typed is the unit, and that distinction is the whole rule:
 * "plan b" is two chunks of one word each, so `b` is kept and goes on narrowing
 * the search, as a second word must. Dropping every one-letter word instead —
 * which is what this did first — made "plan b" return exactly what "plan"
 * returns, and made a single-character CJK word unsearchable beside any other.
 * A chunk that is *all* one-letter pieces keeps them: "a-b" asked as nothing at
 * all would be worse than asked as written.
 */
const wordsOf = (query: string): string[] =>
	query
		.split(/\s+/)
		.filter((chunk) => chunk !== '')
		.flatMap((chunk) => {
			const pieces = tokenize(chunk).filter((word) => word !== '');
			const longer = pieces.filter((word) => word.length > 1);
			return pieces.length > 1 && longer.length > 0 ? longer : pieces;
		});

/** Everything a regular expression reads as syntax, as literal characters. */
const literally = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Characters of context before the match, and the length of the whole excerpt.
 *
 * `BEFORE` is small on purpose. The excerpt is read in a column a little over
 * forty characters wide, and the match has to be *in* what the user sees: put
 * forty characters of run-up in front of it and the highlight lands at or past
 * where the column clips, so the one thing the excerpt exists to show is the one
 * thing not on screen.
 *
 * `LENGTH` is what three of those lines hold, which is what the pane clamps the
 * excerpt to. Overshooting is not free: the clamp cuts what is past it without
 * an ellipsis of its own, and the `…` this module adds to say there is more note
 * is cut away with it — so the excerpt would end mid-word, saying nothing.
 */
const BEFORE = 18;
const LENGTH = 135;

const ELLIPSIS = '…';

/** A letter or a digit: what a word cannot start immediately after. */
const INSIDE_A_WORD = /[\p{L}\p{N}]/u;

/** Where in `line` the terms match, at the start of a word and longest first. */
const matchesIn = (line: string, terms: readonly string[]): { at: number; text: string }[] => {
	// Longest first, because the alternation takes the first branch that matches:
	// with `meet|meeting` against "the meeting", the shorter one wins and marks
	// `meet` inside a word the user can see is longer. A term one character long
	// is dropped — MiniSearch's tokenizer splits on punctuation, so "don't" and
	// "e-mail" arrive carrying a bare `t` and `e`, and marking those paints a box
	// round half the letters in the line.
	const usable = [...terms]
		.filter((term) => term.length > 1)
		.sort((one, two) => two.length - one.length);
	if (usable.length === 0) return [];

	return (
		[...line.matchAll(new RegExp(usable.map(literally).join('|'), 'giu'))]
			// A term matches a word the note *starts*, not a run of letters inside
			// one: `he` is a word here and is also in "the", "there" and "another".
			// Only the start is checked — a prefix query matched a longer word on
			// purpose, and requiring the end too would unmark every one of those.
			.filter((match) => !INSIDE_A_WORD.test(line.charAt(match.index - 1)))
			.map((match) => ({ at: match.index, text: match[0] }))
	);
};

/** A cut that would leave half of a surrogate pair, moved off it. */
const whole = (line: string, at: number): number =>
	at > 0 && at < line.length && /[\uDC00-\uDFFF]/.test(line.charAt(at)) ? at - 1 : at;

/**
 * The start of the word `at` falls inside, moved forward rather than back: an
 * excerpt opening "…ading one two" reads as a typo, where "…one two" reads as a
 * cut. Never past `before`, which is where the match is — the run-up may be
 * shortened to keep a whole word, never shortened past the thing it leads to.
 */
const wordStart = (line: string, at: number, before: number): number => {
	if (at === 0) return 0;
	const space = line.indexOf(' ', at);
	return space >= 0 && space + 1 <= before ? space + 1 : at;
};

/**
 * The body around its first match, split into the runs that matched and the
 * runs that did not.
 *
 * Marked terms come back as data rather than as HTML: the excerpt is user text,
 * and a module that returns `<mark>` around it has made every caller responsible
 * for escaping the rest. The component walks the runs instead.
 *
 * The terms are MiniSearch's, not the query's — a prefix or a fuzzy match means
 * the word in the note is not the word that was typed, and highlighting what was
 * typed would leave the actual match unmarked.
 */
const excerptOf = (body: string, terms: readonly string[]): Excerpt[] => {
	// One line of readable text, by the same rule the note list's preview uses,
	// so the two never disagree about what a note says. It happens before
	// anything is measured, so every offset the window is cut at is an offset
	// into what the user will actually see.
	const line = previewText(body);
	if (line === '') return [];

	const found = matchesIn(line, terms);
	// A match in the title or the tags and nowhere in the body: there is nothing
	// to centre on, so the excerpt is simply the start of the note.
	const first = found[0];
	const from =
		first === undefined
			? 0
			: whole(line, wordStart(line, Math.max(0, first.at - BEFORE), first.at));
	const to = whole(line, Math.min(line.length, from + LENGTH));

	// Runs are cut at the matches that fall wholly inside the window — one
	// clipped by either end is text, not a highlight the user could read.
	const inside = found.filter((match) => match.at >= from && match.at + match.text.length <= to);
	const runs = inside.reduce<Readonly<{ runs: Excerpt[]; at: number }>>(
		(built, match) => ({
			runs: [
				...built.runs,
				{ text: line.slice(built.at, match.at), hit: false },
				{ text: match.text, hit: true },
			],
			at: match.at + match.text.length,
		}),
		{ runs: [], at: from }
	);

	return [
		// The ellipses go inside the runs rather than beside them, so that a
		// caller rendering the runs in order has the whole excerpt and no separate
		// rule about what surrounds it.
		...(from > 0 ? [{ text: ELLIPSIS, hit: false }] : []),
		...[...runs.runs, { text: line.slice(runs.at, to), hit: false }].filter(
			(run) => run.text !== ''
		),
		...(to < line.length ? [{ text: ELLIPSIS, hit: false }] : []),
	];
};

export const createNoteSearch = (): NoteSearch => {
	const index = new MiniSearch<Indexed>({
		fields: ['title', 'tags', 'body'],
		// The rows are kept here, beside the index, so a hit can be handed back
		// as the note itself. Storing copies of the fields in MiniSearch as well
		// would hold the corpus twice.
		storeFields: [],
	});
	const held = new Map<string, string>();
	const rows = new Map<string, NoteRecord>();

	const refresh = (notes: readonly NoteRecord[]): void => {
		const live = new Set(notes.map((note) => note.id));
		[...held.keys()]
			.filter((id) => !live.has(id))
			.forEach((id) => {
				index.discard(id);
				held.delete(id);
				rows.delete(id);
			});
		notes.forEach((note) => {
			// Always, even when the indexed fields have not moved: the row carries
			// things the index does not — whether the note is dirty, when it was
			// edited — and the results are drawn from these.
			rows.set(note.id, note);
			const now = fingerprint(note);
			if (held.get(note.id) === now) return;
			if (held.has(note.id)) index.replace(indexed(note));
			else index.add(indexed(note));
			held.set(note.id, now);
		});
	};

	const find = (query: string): NoteHit[] => {
		const asked = wordsOf(query);
		if (asked.length === 0) return [];
		// Asked word by word rather than as one string, so that the words worth
		// asking about can be chosen: MiniSearch's tokenizer splits on
		// punctuation, so "don't" and "e-mail" arrive carrying a bare `t` and
		// `e`, and a one-letter term with `prefix` on matches most of the notes
		// there are — and every word in them, which the excerpt then marks.
		const results = index.search(
			{ combineWith: 'AND', queries: asked },
			{
				// As-you-type: the last word is still being written, so a prefix must
				// count. Fuzzy at a fifth of the word's length catches a typo and a
				// plural without matching everything.
				prefix: true,
				fuzzy: 0.2,
				// A title is what the user is usually looking for, and a tag was put
				// on the note deliberately; a word in a long body says least.
				boost: { title: 3, tags: 2 },
				// Two words narrow the search. Anything else makes a second word
				// widen it, which is not what typing more means.
				combineWith: 'AND',
			}
		);

		const hits = results.flatMap(
			(result): Readonly<{ note: NoteRecord; terms: readonly string[]; score: number }>[] => {
				const note = rows.get(result.id as string);
				return note === undefined
					? []
					: [{ note, terms: result.terms, score: result.score }];
			}
		);

		// Score first, as MiniSearch ordered them. But two notes matching the same
		// word the same way score the same, and which of them comes first is then
		// whichever was indexed first — that is the order the rows arrived in,
		// which is not an order the user can see any sense in. Ties go to the most
		// recently edited, as everywhere else the app lists notes.
		return (
			[...hits]
				.sort(
					(one, two) => two.score - one.score || two.note.updatedAt - one.note.updatedAt
				)
				// Cut before the excerpts are made: a short query can match every
				// note there is, and each excerpt walks a whole body. Nobody reads
				// the six hundredth match, and the row for it is built and rendered
				// on every keystroke. One past what the pane shows, so it can tell
				// whether anything was left out.
				.slice(0, SEARCH_LIMIT + 1)
				.map(({ note, terms }) => ({ note, excerpt: excerptOf(note.body, terms) }))
		);
	};

	return { refresh, find };
};
