import type { Link, Paragraph, PhrasingContent, RootContent } from 'mdast';

import { hrefFileName, isAttachmentHref } from './attachments.js';
import { parse } from './pipeline.js';

/**
 * A note's body as the lines a list can show: the text the rich editor puts on
 * screen, with none of the markdown that put it there.
 *
 * Heading hashes, quote carets, bullets and list numbers, task checkboxes, and
 * thematic breaks all go. So does inline syntax: `**bold**` reads "bold", and a
 * link reads as its words without its URL. A code block keeps every character it
 * holds, because inside one nothing is markdown, and that is also what the
 * editor shows there. Whitespace is collapsed throughout, this being one line of
 * grey text and not a listing.
 *
 * It is what the note list's preview and the search excerpt are both cut from,
 * so neither can find different words in a note than the other.
 *
 * **It is a parse, and that reverses what this module used to be (2026-10-01).**
 * It was a pass over the string, removing only what a *line* is made of, because
 * the parse was measured at about a millisecond for a 300-word note and judged
 * the wrong price for a line of grey text. A preview full of asterisks, brackets
 * and URLs was the cost of that, and it was the wrong one: the rich editor shows
 * none of them, so the list described a different note from the one beside it.
 * The price is paid once per body rather than per render — the app memoises it
 * (`apps/web/src/store/visibleText.ts`) and gives the list only a note's opening
 * to parse (docs/ARCHITECTURE.md §7).
 *
 * Reading the same markdown the editor reads is also what retires the guesses a
 * pass over the string had to make about the user's punctuation. A `#hashtag`,
 * a hyphen inside a sentence and a `1984` that opens one are text because the
 * parser says so, not because a regular expression was careful.
 */

/**
 * The break Milkdown writes for an empty paragraph, which is the one thing in a
 * note the user did not type. Markdown has no way to say "a blank paragraph
 * here", so the editor writes an HTML break and reads it back
 * (docs/ARCHITECTURE.md §7), and it must not be what the user reads in a list.
 *
 * Only a block that is nothing else, which is the only shape Milkdown writes. A
 * `<br>` in the middle of a sentence is the user's own text — in prose, or in a
 * note about HTML — and is kept, as are two in a row, which nothing but a person
 * writes.
 */
const EDITOR_BREAK = /^\s*<br\s*\/?>\s*$/i;

/**
 * A link the rich editor shows as a file's chip: one run of plain words, to a
 * file beside the note (`apps/web/src/editor/attachment.ts`).
 */
const isChip = (link: Link): boolean => {
	const [only, ...rest] = link.children;
	return isAttachmentHref(link.url) && rest.length === 0 && (only?.type ?? 'text') === 'text';
};

/**
 * What a picture or a chip says, apart from the words either side of it. Each
 * is a thing of its own on screen, never part of a word, and written with
 * nothing between it and the text before it — `coast![Pasted image](…)` — it
 * would otherwise read "coastPasted image".
 */
const apart = (words: string): string => ` ${words} `;

/** How a run of a line's words is set, as the rich editor sets them. */
export type PreviewMark = 'strong' | 'emphasis' | 'delete' | 'code' | 'link';

/**
 * A picture or a file's chip, as the rich editor draws it in a line: what a
 * scratchpad card draws there too (`apps/web/src/components/Scratchpad.tsx`).
 * The run it is on still says it in words — its alt text, the chip's name —
 * for all that reads only words, so `previewLines` is the same with or
 * without it.
 */
export type PreviewEmbed = Readonly<
	| { kind: 'image'; src: string; alt: string }
	| { kind: 'file'; href: string; name: string; fileName: string }
>;

/** Words set one way: a line is a row of these. */
export interface PreviewRun {
	readonly text: string;
	readonly marks: readonly PreviewMark[];
	/** A picture or a chip, where the run is one: drawn whole, or not at all. */
	readonly embed?: PreviewEmbed;
}

/** What an item's first line starts with: its bullet, its number, or its box. */
export type PreviewMarker = Readonly<
	{ kind: 'bullet' } | { kind: 'number'; value: number } | { kind: 'task'; checked: boolean }
>;

/**
 * One line of a body as the rich editor shows it: its words, set as they are
 * there, and what the line is — a heading's, a list item's, a quote's or a
 * code block's — where that changes how it is drawn.
 */
export interface PreviewLine {
	readonly runs: readonly PreviewRun[];
	/** How many lists deep it is: 0 outside one. */
	readonly depth: number;
	/** A heading's level, 1 to 6. */
	readonly heading?: number;
	/** An item's first line: what it starts with. */
	readonly marker?: PreviewMarker;
	/** A line of a quote. */
	readonly quote?: true;
	/** A line of a code block, which keeps every character in it. */
	readonly code?: true;
}

/** What a line is, apart from its words. */
type LineKind = Omit<PreviewLine, 'runs'>;

/** A run of inline content as it looks on screen, in runs of one style each. */
const inline = (node: PhrasingContent, marks: readonly PreviewMark[]): PreviewRun[] => {
	const inside = (mark: PreviewMark | undefined) =>
		'children' in node
			? node.children.flatMap((child) =>
					inline(
						child,
						mark === undefined || marks.includes(mark) ? marks : [...marks, mark]
					)
				)
			: [];
	switch (node.type) {
		// Inline html is shown as written, as the rich editor shows it: an atom
		// holding the tag.
		case 'text':
		case 'html':
			return [{ text: node.value, marks }];
		case 'inlineCode':
			return [{ text: node.value, marks: [...marks, 'code'] }];
		case 'break':
			return [{ text: '\n', marks }];
		case 'image':
			return [
				{
					text: apart(node.alt ?? ''),
					marks,
					embed: { kind: 'image', src: node.url, alt: node.alt ?? '' },
				},
			];
		// Its address is in a definition elsewhere in the note, which a line
		// cannot see: its words.
		case 'imageReference':
			return [{ text: apart(node.alt ?? ''), marks }];
		// The rich editor cannot show a footnote at all, and sends the note to raw
		// mode (§7) — where this is what is on screen.
		case 'footnoteReference':
			return [{ text: `[^${node.label ?? node.identifier}]`, marks }];
		case 'link':
			return isChip(node) ? [chip(node, marks)] : inside('link');
		case 'emphasis':
			return inside('emphasis');
		case 'strong':
			return inside('strong');
		case 'delete':
			return inside('delete');
		case 'linkReference':
			return inside('link');
		default:
			return [];
	}
};

/** What a chip says: its words, or the file's name where it has none, as the editor shows it. */
const chipWords = (link: Link): string => {
	const words = textOf(link.children.flatMap((child) => inline(child, [])));
	return words === '' ? hrefFileName(link.url) : words;
};

const chip = (link: Link, marks: readonly PreviewMark[]): PreviewRun => {
	const name = chipWords(link);
	return {
		text: apart(name),
		marks,
		embed: { kind: 'file', href: link.url, name, fileName: hrefFileName(link.url) },
	};
};

const textOf = (runs: readonly PreviewRun[]): string => runs.map((run) => run.text).join('');

const isEditorBreak = (paragraph: Paragraph): boolean => {
	const [only, ...rest] = paragraph.children;
	return rest.length === 0 && only?.type === 'html' && EDITOR_BREAK.test(only.value);
};

/** Runs as lines, at the breaks inside them. */
const atBreaks = (runs: readonly PreviewRun[]): PreviewRun[][] => {
	const pieces = runs.flatMap((run) =>
		run.text.split('\n').map((text, at) => ({ run: { ...run, text }, opens: at > 0 }))
	);
	const starts = [0, ...pieces.flatMap((piece, at) => (piece.opens ? [at] : []))];
	return starts.map((start, at) => pieces.slice(start, starts[at + 1]).map(({ run }) => run));
};

/** Plain words, a line of them to each line of `text`. */
const plainLines = (text: string, marks: readonly PreviewMark[] = []): PreviewRun[][] =>
	text.split('\n').map((line) => [{ text: line, marks }]);

const phrasing = (children: readonly PhrasingContent[]): PreviewRun[][] =>
	atBreaks(children.flatMap((child) => inline(child, [])));

/** The lines a block puts on screen, before whitespace is collapsed. */
const blockLines = (node: RootContent, kind: LineKind): PreviewLine[] => {
	const as = (lines: readonly PreviewRun[][], more: Partial<LineKind> = {}): PreviewLine[] =>
		lines.map((runs) => ({ ...kind, ...more, runs }));
	switch (node.type) {
		case 'paragraph':
			return isEditorBreak(node) ? [] : as(phrasing(node.children));
		case 'heading':
			return as(phrasing(node.children), { heading: node.depth });
		case 'code':
			return as(plainLines(node.value), { code: true });
		case 'html':
			return EDITOR_BREAK.test(node.value) ? [] : as(plainLines(node.value));
		case 'table':
			return as(
				node.children.map((row) =>
					row.children.flatMap((cell, at) => [
						...(at === 0 ? [] : [{ text: ' ', marks: [] }]),
						...cell.children.flatMap((child) => inline(child, [])),
					])
				)
			);
		case 'blockquote':
			return node.children.flatMap((child) => blockLines(child, { ...kind, quote: true }));
		case 'list':
			return node.children.flatMap((item, at) =>
				blockLines(item, {
					...kind,
					depth: kind.depth + 1,
					marker:
						typeof item.checked === 'boolean'
							? { kind: 'task', checked: item.checked }
							: node.ordered === true
								? { kind: 'number', value: (node.start ?? 1) + at }
								: { kind: 'bullet' },
				})
			);
		// The marker is the item's first line's; the lines after it are the
		// item's too, under its words.
		case 'listItem':
			return node.children
				.flatMap((child) => blockLines(child, { ...kind, marker: undefined }))
				.map((line, at) =>
					at === 0 && kind.marker !== undefined ? { ...line, marker: kind.marker } : line
				);
		case 'footnoteDefinition':
			return node.children.flatMap((child) => blockLines(child, kind));
		// A thematic break, a link definition: nothing a reader sees as words.
		default:
			return [];
	}
};

/**
 * A line's runs with whitespace collapsed as `previewLines` collapses it — a
 * run of it, however it falls across the runs, is one space, and none at
 * either end — and the runs it leaves empty dropped. A run's leading space
 * goes where the run before it ends in one: if that one was nothing but a
 * space and went itself, it went for the same reason, so the one before it
 * ends in a space too.
 */
const collapsed = (runs: readonly PreviewRun[]): PreviewRun[] => {
	// A picture with no words is still a picture.
	const kept = (run: PreviewRun) => run.text !== '' || run.embed !== undefined;
	const squeezed = runs
		.map((run) => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
		.filter(kept);
	const spaced = squeezed
		.map((run, at) =>
			at === 0 || squeezed[at - 1]?.text.endsWith(' ') === true
				? { ...run, text: run.text.replace(/^ /, '') }
				: run
		)
		.filter(kept);
	const last = spaced.at(-1);
	if (last === undefined) return [];
	const end = { ...last, text: last.text.replace(/ $/, '') };
	return kept(end) ? [...spaced.slice(0, -1), end] : spaced.slice(0, -1);
};

/**
 * The readable lines of a body, in order, each with how it is set: what a
 * scratchpad card draws (`apps/web/src/components/Scratchpad.tsx`). Whitespace
 * is collapsed and blank lines dropped, so the words of each are exactly
 * `previewLines`'s.
 */
export const previewBlocks = (body: string): PreviewLine[] =>
	parse(body)
		.children.flatMap((node) => blockLines(node, { depth: 0 }))
		.map((line) => ({ ...line, runs: collapsed(line.runs) }))
		.filter((line) => line.runs.length > 0);

/** A preview line's words, as one string. */
export const previewLineText = (line: PreviewLine): string => textOf(line.runs);

/**
 * The readable lines of a body, in order, whitespace collapsed and blanks
 * dropped — a line that is only a picture with no words among them.
 */
export const previewLines = (body: string): string[] =>
	previewBlocks(body)
		.map(previewLineText)
		.filter((line) => line !== '');

/**
 * One line of readable text for the whole body, which is what an excerpt is cut
 * from and what a preview is truncated from.
 */
export const previewText = (body: string): string => previewLines(body).join(' ');
