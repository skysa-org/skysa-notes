import { toString as nodeToString } from 'mdast-util-to-string';

import { NOTE_EXTENSION } from '../config.js';
import { toLf } from './lineEndings.js';
import { parse } from './pipeline.js';
import { foldName } from './slug.js';

/**
 * Title is frontmatter `title`, else the first heading, else the filename.
 * See docs/ARCHITECTURE.md §7.
 */
export interface DeriveTitleInput {
	frontmatterTitle?: string | undefined;
	/** Body markdown, frontmatter already stripped. */
	body?: string | undefined;
	/** Filename with extension, used as the last resort. */
	filename?: string | undefined;
}

/** The first top-level heading in `markdown` with any text: that text, and the heading as written. */
const headingIn = (markdown: string): { text: string; written: string } | undefined =>
	parse(markdown)
		.children.filter((node) => node.type === 'heading')
		.map((node) => ({
			text: nodeToString(node).trim(),
			written: markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset),
		}))
		.find(({ text }) => text !== '');

/**
 * A line a heading may be, or end on: an opening `#`, or a setext underline.
 * Only a cue for how far to read; what is a heading is the parser's to say.
 */
const MAY_HEAD = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$)/m;

/**
 * The first heading's text, read only as far as it.
 *
 * Parsing the whole body for it was most of what reading a note cost (#275):
 * an import or a pull of a few thousand notes, and every autosave of a note
 * named by its heading, paid for a parse of every word to find the first line.
 * So the body is read up to the first line a heading may be, and no further.
 * What those lines are does not depend on any line after them — a heading is
 * one line, or a paragraph and the underline that ends it — so a heading found
 * there is the first in the whole body. Save one thing: a reference (`[a][b]`,
 * `[b]`, `[^1]`) in the heading is a link only if it is defined somewhere, and
 * its text differs; so where the heading holds a `[`, or none is found, the
 * whole body is read, as before. A line that looked like a heading and was not
 * (a rule, a `#` in code) costs a read as far as it on top, so past half the
 * body the whole is read at once: a note with no heading costs at most half as
 * much again as it did, and one with a heading near its top a few lines' worth.
 */
const firstHeadingText = (body: string): string | undefined => {
	const markdown = toLf(body);
	const cue = MAY_HEAD.exec(markdown);
	if (cue === null || cue.index > markdown.length / 2) return headingIn(markdown)?.text;
	const end = markdown.indexOf('\n', cue.index);
	if (end === -1) return headingIn(markdown)?.text;
	const found = headingIn(markdown.slice(0, end + 1));
	if (found !== undefined && !found.written.includes('[')) return found.text;
	return headingIn(markdown)?.text;
};

/**
 * The title of a note with nothing to take a name from: kept, and compared, as
 * it is, in every language. An app shows it in the user's (docs/ARCHITECTURE.md
 * §7, "The app's words"); as a name it is `UNTITLED_SLUG`.
 */
export const UNTITLED_TITLE = 'Untitled';

/** Strip the extension and turn slug separators back into spaces. */
export const titleFromFilename = (filename: string): string => {
	const withoutExtension = foldName(filename).endsWith(NOTE_EXTENSION)
		? filename.slice(0, -NOTE_EXTENSION.length)
		: filename;
	return withoutExtension.replace(/[-_]+/g, ' ').trim();
};

export const deriveTitle = (input: DeriveTitleInput): string => {
	const fromFrontmatter = input.frontmatterTitle?.trim();
	if (fromFrontmatter) return fromFrontmatter;

	if (input.body) {
		const fromHeading = firstHeadingText(input.body);
		if (fromHeading) return fromHeading;
	}

	if (input.filename) {
		const fromFilename = titleFromFilename(input.filename);
		if (fromFilename) return fromFilename;
	}

	return UNTITLED_TITLE;
};
