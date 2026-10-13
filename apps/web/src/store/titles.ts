import { basename, clusters, titleFromFilename, UNTITLED_TITLE } from '@skysa/core';

import { t } from '../i18n/t.js';
import { type NoteRecord } from './db.js';
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
 * scratchpad, `untitled 2`.
 */
export const nameless = (note: NoteRecord): boolean =>
	note.title === UNTITLED_TITLE ||
	(isUnnamed(note) && note.title === titleFromFilename(basename(note.path)));

/** The most characters, as a reader counts them, of a line that `wordsShown` keeps. */
const NAME_LENGTH = 40;

/**
 * `line` to `NAME_LENGTH`, and "…" where it was cut: after its last whole word,
 * unless that leaves under half of it — a long address is cut where it reaches
 * the end. Cut between characters (`clusters`), never through an emoji.
 */
const shortened = (line: string): string => {
	const all = clusters(line);
	if (all.length <= NAME_LENGTH) return line;
	const cut = all.slice(0, NAME_LENGTH).join('');
	const words = /\s/u.test(all[NAME_LENGTH] ?? '') ? cut : cut.replace(/\s+\S*$/u, '');
	return `${(words.length > cut.length / 2 ? words : cut).trimEnd()}…`;
};

/**
 * The words a note with no name goes by where one line has to say which note
 * it is — the compact bar's dropdown, a card's name over it, the notice a
 * delete leaves (2026-10-13): its opening line, as its row in the list shows
 * it (`noteOpening`), shortened. Undefined for a note with a name, or with no
 * words to go by. `keep: false` for a body being typed (`openingLines`).
 */
export const wordsShown = (
	note: NoteRecord,
	options: { keep?: boolean } = {}
): string | undefined => {
	if (!nameless(note)) return undefined;
	const [first] = noteOpening(openingLines(note.body, options), note);
	return first === undefined ? undefined : shortened(first);
};

/** A note's name as it is shown, where it has none its first words (`wordsShown`). */
export const nameShown = (note: NoteRecord, options: { keep?: boolean } = {}): string =>
	wordsShown(note, options) ?? titleShown(note.title);
