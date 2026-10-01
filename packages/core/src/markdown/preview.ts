import type { Paragraph, PhrasingContent, RootContent } from 'mdast';

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

/** What a run of inline content looks like on screen. */
const inline = (node: PhrasingContent): string => {
	switch (node.type) {
		// Inline html is shown as written, as the rich editor shows it: an atom
		// holding the tag.
		case 'text':
		case 'inlineCode':
		case 'html':
			return node.value;
		case 'break':
			return '\n';
		case 'image':
		case 'imageReference':
			return node.alt ?? '';
		// The rich editor cannot show a footnote at all, and sends the note to raw
		// mode (§7) — where this is what is on screen.
		case 'footnoteReference':
			return `[^${node.label ?? node.identifier}]`;
		case 'emphasis':
		case 'strong':
		case 'delete':
		case 'link':
		case 'linkReference':
			return node.children.map(inline).join('');
		default:
			return '';
	}
};

const isEditorBreak = (paragraph: Paragraph): boolean => {
	const [only, ...rest] = paragraph.children;
	return rest.length === 0 && only?.type === 'html' && EDITOR_BREAK.test(only.value);
};

/** The lines a block puts on screen, before whitespace is collapsed. */
const blockLines = (node: RootContent): string[] => {
	switch (node.type) {
		case 'paragraph':
			return isEditorBreak(node) ? [] : node.children.map(inline).join('').split('\n');
		case 'heading':
			return node.children.map(inline).join('').split('\n');
		case 'code':
			return node.value.split('\n');
		case 'html':
			return EDITOR_BREAK.test(node.value) ? [] : node.value.split('\n');
		case 'table':
			return node.children.map((row) =>
				row.children.map((cell) => cell.children.map(inline).join('')).join(' ')
			);
		case 'blockquote':
		case 'list':
		case 'listItem':
		case 'footnoteDefinition':
			return node.children.flatMap(blockLines);
		// A thematic break, a link definition: nothing a reader sees as words.
		default:
			return [];
	}
};

/** The readable lines of a body, in order, whitespace collapsed and blanks dropped. */
export const previewLines = (body: string): string[] =>
	parse(body)
		.children.flatMap(blockLines)
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line !== '');

/**
 * One line of readable text for the whole body, which is what an excerpt is cut
 * from and what a preview is truncated from.
 */
export const previewText = (body: string): string => previewLines(body).join(' ');
