import { previewBlocks, type PreviewLine, previewLineText } from '@skysa/core';

import { isCreatedLine, isTimeLine } from './createdLine.js';

/**
 * A note's visible text, parsed once per body.
 *
 * `previewBlocks` is a parse (`packages/core/src/markdown/preview.ts`): about a
 * millisecond for a 300-word note and ten for a 3000-word one. The note list,
 * the scratchpad's cards and the search answers ask it again on every render,
 * and a list renders on every keystroke in the note beside it, so the answer is
 * kept, by the body it is for. A body is its own key: the same text is the same
 * answer, and an edit is a new key rather than a stale entry to invalidate.
 *
 * One parse serves both shapes of answer. The blocks — each line with how it
 * is set, which a card draws — are what is kept, and the lines of text a list
 * row joins are read off them (`previewLineText`), kept beside them for as long
 * as they are. A card's wall asks for the lines and the card for the blocks of
 * the same body, and they were two parses.
 *
 * Bounded, oldest first out, because the keys are whole bodies: it holds what
 * the screen keeps asking about, not every version of every note the tab has
 * seen. At least `LIMIT`, and more while a longer list is shown
 * (`keepOpenings`): a bound under the rows drawn is no cache, since drawing the
 * list again asks for every row in the order the last draw put them out.
 */

const LIMIT = 400;

/** How much more than the lists' rows is kept: what is drawn beside them, such as search answers. */
const ROOM = 1.25;

/** The longest each list has been, by name: the note list and the scratchpad can both be drawn. */
const lists = new Map<string, number>();

/**
 * Keep room for `list`'s `count` rows, each asking for its opening on every
 * draw. Only ever grows: a list shown once is likely shown again, and what it
 * keeps is the openings of notes that are on the device anyway.
 */
export const keepOpenings = (list: string, count: number): void => {
	if (count > (lists.get(list) ?? 0)) lists.set(list, count);
};

/** The most kept: `LIMIT`, or more once longer lists have been shown. */
const most = (): number =>
	Math.max(LIMIT, Math.ceil([...lists.values()].reduce((sum, each) => sum + each, 0) * ROOM));

const seen = new Map<string, readonly PreviewLine[]>();

/**
 * The blocks of `body`, kept in `seen` for the next time they are asked for.
 *
 * `keep: false` for a body being typed (`store/liveEdits.ts`), which is asked
 * once and never again: one kept per keystroke would push every other note's
 * answer out within a paragraph, and the whole list would be parsed again the
 * next time it drew.
 */
const blocksOf = (body: string, { keep = true }: { keep?: boolean }): readonly PreviewLine[] => {
	const known = seen.get(body);
	if (known !== undefined) {
		// To the back of the queue: asked again, so kept longest.
		seen.delete(body);
		seen.set(body, known);
		return known;
	}
	const answer = previewBlocks(body);
	if (!keep) return answer;
	seen.set(body, answer);
	if (seen.size > most()) {
		const oldest = seen.keys().next();
		if (oldest.done !== true) seen.delete(oldest.value);
	}
	return answer;
};

/** The lines of text read off each kept set of blocks, gone with them. */
const linesRead = new WeakMap<readonly PreviewLine[], readonly string[]>();

/** The readable lines of blocks, as `previewLines` gives them: blanks dropped. */
const linesOf = (blocks: readonly PreviewLine[]): readonly string[] => {
	const known = linesRead.get(blocks);
	if (known !== undefined) return known;
	const lines = blocks.map(previewLineText).filter((line) => line !== '');
	linesRead.set(blocks, lines);
	return lines;
};

export const visibleLines = (body: string, options: { keep?: boolean } = {}): readonly string[] =>
	linesOf(blocksOf(body, options));

/** The visible lines with how each is set, which a scratchpad card draws. */
export const visibleBlocks = (
	body: string,
	options: { keep?: boolean } = {}
): readonly PreviewLine[] => blocksOf(body, options);

/** The whole body's visible text as one line, which an excerpt is cut from. */
export const visibleText = (body: string): string => visibleLines(body).join(' ');

/**
 * How much of a body a list row's preview is read from. A row shows a hundred
 * and twenty characters, so a long note's tail is never on screen, and parsing
 * it would make the list's cost grow with the length of the notes in it.
 */
const OPENING = 2_000;

/**
 * The visible lines of a note's opening: what a list row needs and no more.
 *
 * Cut at the end of a line, so the last line read is a whole one. Cutting a
 * note's markdown short can only leave a construct unfinished — a fence run to
 * the cut, a table missing rows — and each of those still shows its words; the
 * one thing it can hide is a reference link's definition further down, and
 * then the link shows as the brackets the user typed.
 */
export const openingLines = (body: string, options: { keep?: boolean } = {}): readonly string[] =>
	visibleLines(opening(body), options);

/** The same opening's lines with how each is set (`visibleBlocks`). */
export const openingBlocks = (
	body: string,
	options: { keep?: boolean } = {}
): readonly PreviewLine[] => visibleBlocks(opening(body), options);

/** A body to its first `OPENING` characters, and on to the end of the line they end in. */
const opening = (body: string): string => {
	if (body.length <= OPENING) return body;
	const end = body.indexOf('\n', OPENING);
	return end === -1 ? body : body.slice(0, end);
};

/**
 * Whether a line is the note's title written out again.
 *
 * The line is parsed text, and a title derived from a heading is too, so the
 * two usually agree as they stand. Emphasis characters are still ignored on
 * both sides, for a title that was *written* rather than derived — `title:` in
 * frontmatter, spelled `**Alpha**` above a `# Alpha` — and on both sides
 * because the parse removes only the characters that were emphasis: a title of
 * `setup_guide` keeps its underscore, and stripping one side alone would leave
 * "setupguide" against "setup_guide" and print the heading twice.
 */
const bare = (text: string): string => text.replaceAll(/[*_`]/g, '').trim();

const isTitle = (line: string | undefined, title: string): boolean =>
	line !== undefined && bare(line) === bare(title);

/**
 * A note's opening, after its title: what a list row (`NoteList`) and a
 * scratchpad card (`Scratchpad`) show of it. `previewLines` decides what a
 * readable line is — the visible text, as the rich editor shows it, and the
 * same rule the search excerpt is cut by — and the title is dropped from the
 * front of them so the row does not say it twice.
 *
 * Dropped by *identity*, not by position. Taking the first line on the
 * assumption that it is the heading was wrong in both directions: a note
 * beginning with the `<br />` the editor writes for an empty paragraph has no
 * heading on line one, and lost a line of the user's own writing instead — and
 * a note whose heading comes after an introduction had the introduction eaten
 * and the heading shown. Comparing against the title the row is already
 * displaying is the question actually being asked.
 *
 * So is a line that says only when the note was made, as OneNote puts under
 * every title (`isCreatedLine`), above the title or below it, and a time of
 * day on the line after it: the list is in that order already, and the line
 * was all the row had room for.
 */
export const noteOpening = (
	lines: readonly string[],
	note: Readonly<{ title: string; createdAt: number }>,
	passed: { title?: true; date?: true } = {}
): readonly string[] => {
	const [line, ...rest] = lines;
	if (passed.title === undefined && isTitle(line, note.title))
		return noteOpening(rest, note, { ...passed, title: true });
	if (passed.date === undefined && isCreatedLine(line, note.createdAt))
		return noteOpening(isTimeLine(rest[0]) ? rest.slice(1) : rest, note, {
			...passed,
			date: true,
		});
	return lines;
};
