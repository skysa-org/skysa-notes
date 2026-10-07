import {
	isScratchPath,
	type PreviewLine,
	previewLineText,
	type PreviewRun,
	readFrontmatter,
	type ScratchColor,
	scratchColor,
} from '@skysa/core';

import { type NoteRecord, type NotesDatabase } from './db.js';
import { getPreference, setPreference } from './prefs.js';

/**
 * The scratchpad (docs/ARCHITECTURE.md §7, "The scratchpad"): quick notes that
 * live in a hidden folder of their own, `.scratchpad/`, shown as cards rather
 * than in a notebook. Each is an ordinary note row, synced as any is; this
 * module is what the scratchpad knows that a notebook does not.
 */

/** What the scratchpad is called wherever the app names it. */
export const SCRATCHPAD_LABEL = 'Scratchpad';

/** The key for whether a source shows its scratchpad on this device. */
const shownKey = (connectionId: string): string => `scratchpad:${connectionId}`;

/**
 * Whether this device shows a source's scratchpad. Per device and per source,
 * as the clipboard is, but kept in `prefs` rather than on the source's
 * `syncState` row: the device's own notes have a scratchpad too, and no row.
 * Hidden unless it was shown.
 */
export const getScratchpadShown = async (
	db: NotesDatabase,
	connectionId: string
): Promise<boolean> => (await getPreference(db, shownKey(connectionId))) === 'true';

/**
 * Show or hide a source's scratchpad on this device. Hiding it leaves its notes
 * where they are, synced as before, and shows them again as they were.
 */
export const setScratchpadShown = (
	db: NotesDatabase,
	connectionId: string,
	shown: boolean
): Promise<void> => setPreference(db, shownKey(connectionId), String(shown));

/** Is this note one of the scratchpad's, rather than a notebook's? */
export const isScratchNote = (note: Pick<NoteRecord, 'path'>): boolean => isScratchPath(note.path);

/** A scratch note's pin and colour, as its frontmatter says them. */
export interface ScratchMarks {
	readonly pinned: boolean;
	readonly color: ScratchColor | undefined;
}

const NO_MARKS: ScratchMarks = { pinned: false, color: undefined };

/**
 * The marks of each frontmatter block read so far. A block is a string, so the
 * same note asked again costs a lookup, and a block edited is a new key. A
 * scratchpad is re-listed on every write to the notes table — every autosave of
 * every note — and parsing each card's YAML again each time is the cost this
 * saves. Bounded, as `visibleText`'s cache is.
 */
const marksCache = new Map<string, ScratchMarks>();
const MARKS_KEPT = 400;

export const scratchMarks = (note: Pick<NoteRecord, 'frontmatter'>): ScratchMarks => {
	const { frontmatter } = note;
	if (frontmatter === null) return NO_MARKS;
	const known = marksCache.get(frontmatter);
	if (known !== undefined) return known;
	const read = readFrontmatter(frontmatter);
	const marks: ScratchMarks = { pinned: read.pinned === true, color: scratchColor(read.color) };
	if (marksCache.size >= MARKS_KEPT) {
		const oldest = marksCache.keys().next().value;
		if (oldest !== undefined) marksCache.delete(oldest);
	}
	marksCache.set(frontmatter, marks);
	return marks;
};

/**
 * The scratchpad's cards, as two groups: the pinned, then the rest. Each in the
 * order the notes came in, which `listNotes` gives as newest made first, so an
 * edit never moves a card under the user.
 */
export const scratchGroups = <T extends Pick<NoteRecord, 'frontmatter'>>(
	notes: readonly T[]
): { pinned: T[]; others: T[] } => ({
	pinned: notes.filter((note) => scratchMarks(note).pinned),
	others: notes.filter((note) => !scratchMarks(note).pinned),
});

/** About how much of a note its card shows. */
export const CARD_WORDS = 60;

/** And in no more lines than this, so a list of one word a line is not a card a screen tall. */
export const CARD_LINES = 12;

/** A line's runs up to `end` characters into its words, the run there cut short. */
const runsTo = (runs: readonly PreviewRun[], end: number): readonly PreviewRun[] =>
	runs
		.map((run, at) => {
			const start = runs.slice(0, at).reduce((sum, each) => sum + each.text.length, 0);
			return { ...run, text: run.text.slice(0, Math.max(0, end - start)) };
		})
		.filter((run) => run.text !== '');

/** A line's first `count` words, and nothing after them. */
const firstWords = (line: PreviewLine, count: number): PreviewLine => {
	const last = [...previewLineText(line).matchAll(/\S+/gu)][count - 1];
	return last === undefined
		? line
		: { ...line, runs: runsTo(line.runs, last.index + last[0].length) };
};

/** A line with "…" at its end, set as the words it follows. */
const trailing = (line: PreviewLine): PreviewLine => {
	const last = line.runs.at(-1);
	return last === undefined
		? line
		: { ...line, runs: [...line.runs.slice(0, -1), { ...last, text: `${last.text}…` }] };
};

/**
 * What a card shows of a note's lines: the first `CARD_WORDS` words of them,
 * each line still a line and set as it is in the note, in no more than
 * `CARD_LINES`. A note with more ends in "…" where it was cut.
 */
export const cardLines = (lines: readonly PreviewLine[]): readonly PreviewLine[] => {
	const start = { kept: [] as readonly PreviewLine[], left: CARD_WORDS, cut: false };
	const { kept, cut } = lines.reduce((card, line) => {
		const words = previewLineText(line)
			.split(/\s+/u)
			.filter((word) => word !== '');
		if (card.cut || words.length === 0) return card;
		if (card.left <= 0 || card.kept.length >= CARD_LINES) return { ...card, cut: true };
		if (words.length <= card.left) {
			return { ...card, kept: [...card.kept, line], left: card.left - words.length };
		}
		return { kept: [...card.kept, firstWords(line, card.left)], left: 0, cut: true };
	}, start);
	const end = kept.at(-1);
	return cut && end !== undefined ? [...kept.slice(0, -1), trailing(end)] : kept;
};
