import { basename, clusters, titleFromFilename, UNTITLED_TITLE } from '@skysa/core';

import { t } from '../i18n/t.js';
import { type NoteRecord } from './db.js';
import { frontmatterOf } from './frontmatter.js';
import { isUnnamed } from './notes.js';
import { noteOpening, openingLines } from './visibleText.js';

/**
 * A note's title as it is shown. One with nothing to take a name from is
 * `UNTITLED_TITLE` wherever the app keeps it, and `untitled.md` in the user's
 * folder, in every language, so that it can be told from a name the user gave;
 * only what is on screen says it in theirs (docs/ARCHITECTURE.md §7, "The
 * app's words").
 */
export const titleShown = (title: string): string =>
	title === UNTITLED_TITLE ? t('notes.untitled') : title;

/**
 * Whether a note goes by no name but the one the app falls back on: nothing to
 * take one from, or only the filename it was given for want of one
 * (`isUnnamed`), which another device reads back as `untitled` and, in the
 * scratchpad, `untitled 2`. A `title` the user gave is a name, "Untitled" too.
 */
export const nameless = (note: NoteRecord): boolean =>
	frontmatterOf(note.frontmatter).title === undefined &&
	(note.title === UNTITLED_TITLE ||
		(isUnnamed(note) && note.title === titleFromFilename(basename(note.path))));

/** The most characters, as a reader counts them, of a line that `shownName` keeps. */
const NAME_LENGTH = 40;

/**
 * How much of a line is split into characters to find its first
 * `NAME_LENGTH`: enough for them however many code units each takes, and no
 * more, since a pasted paragraph can be one line of thousands.
 */
const SCANNED = NAME_LENGTH * 16;

/** Where a word ends: before a space, or before punctuation that a space or the end follows. */
const endsWord = (next: string | undefined, after: string | undefined): boolean =>
	next === undefined ||
	/^\s/u.test(next) ||
	(/^\p{P}/u.test(next) && (after === undefined || /^\s/u.test(after)));

/**
 * `line` to `NAME_LENGTH`, and "…" where it was cut: after its last whole word,
 * and any punctuation that ended it, unless that leaves under half of it — a
 * long address is cut where it reaches the end. Cut between characters
 * (`clusters`), never through an emoji.
 */
const shortened = (line: string): string => {
	const head = clusters(line.slice(0, SCANNED));
	const all = head.length > NAME_LENGTH + 1 || line.length <= SCANNED ? head : clusters(line);
	if (all.length <= NAME_LENGTH) return line;
	const cut = all.slice(0, NAME_LENGTH).join('');
	const whole = endsWord(all[NAME_LENGTH], all[NAME_LENGTH + 1])
		? cut
		: cut.replace(/\s+\S*$/u, '');
	const words = whole.replace(/[\s\p{P}]+$/u, '');
	return `${words.length > cut.length / 2 ? words : cut.trimEnd()}…`;
};

/**
 * What a note goes by where one line has to say which note it is — the
 * compact bar's dropdown, a card's name over it, the notice a delete leaves
 * (2026-10-13): its name; or, with none, its first words, its opening line as
 * its row in the list shows it, shortened; or, with neither, "Untitled". Where
 * it came `from`, since the bar cuts words at their end and a name in its
 * middle. `keep: false` for a body being typed (`openingLines`).
 */
export const shownName = (
	note: NoteRecord,
	options: { keep?: boolean } = {}
): { text: string; from: 'name' | 'words' | 'nothing' } => {
	if (!nameless(note)) return { text: titleShown(note.title), from: 'name' };
	// Past the title is not asked: a placeholder is not a line of the note's,
	// and a first line that says "Untitled" is the user's own.
	const [first] = noteOpening(openingLines(note.body, options), note, { title: true });
	return first === undefined
		? { text: titleShown(note.title), from: 'nothing' }
		: { text: shortened(first), from: 'words' };
};

/** A note's name as it is shown, where it has none its first words (`shownName`). */
export const nameShown = (note: NoteRecord): string => shownName(note).text;
