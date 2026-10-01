import { previewLines } from '@skysa/core';

/**
 * A note's visible text, parsed once per body.
 *
 * `previewLines` is a parse (`packages/core/src/markdown/preview.ts`): about a
 * millisecond for a 300-word note and ten for a 3000-word one. The note list
 * and the search answers ask it again on every render, and a note list renders
 * on every keystroke in the note beside it, so the answer is kept, by the body
 * it is for. A body is its own key: the same text is the same answer, and an
 * edit is a new key rather than a stale entry to invalidate.
 *
 * Bounded, oldest first out, because the keys are whole bodies: it holds what
 * the screen keeps asking about, not every version of every note the tab has
 * seen.
 */

const LIMIT = 400;

const seen = new Map<string, readonly string[]>();

export const visibleLines = (body: string): readonly string[] => {
	const known = seen.get(body);
	if (known !== undefined) {
		// To the back of the queue: asked again, so kept longest.
		seen.delete(body);
		seen.set(body, known);
		return known;
	}
	const lines = previewLines(body);
	seen.set(body, lines);
	if (seen.size > LIMIT) {
		const oldest = seen.keys().next();
		if (oldest.done !== true) seen.delete(oldest.value);
	}
	return lines;
};

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
export const openingLines = (body: string): readonly string[] => {
	if (body.length <= OPENING) return visibleLines(body);
	const end = body.indexOf('\n', OPENING);
	return visibleLines(end === -1 ? body : body.slice(0, end));
};
