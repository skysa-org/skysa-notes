import {
	joinFrontmatter,
	type NoteFrontmatter,
	readFrontmatter,
	splitFrontmatter,
	writeFrontmatter,
} from './frontmatter.js';
import { firstLineEnding, withLineEnding } from './lineEndings.js';
import { deriveTitle } from './title.js';

/**
 * A note file, read into its parts. The markdown string is the only source of
 * truth; this is a view of it, not a replacement. Reading a file never changes
 * it — `parseNoteFile` adds nothing and normalizes nothing, so a note authored
 * elsewhere keeps its own formatting until someone actually edits it.
 * See docs/ARCHITECTURE.md §7.
 */
export interface ParsedNoteFile {
	/** `id` from frontmatter. Absent for a file written by another tool. */
	id?: string;
	title: string;
	/** Markdown with the frontmatter block removed. */
	body: string;
	/** Raw YAML between the fences, or null when the file had none. */
	frontmatter: string | null;
	created?: string;
	updated?: string;
	tags: string[];
}

export interface ParseNoteFileOptions {
	/** Used to derive a title when the file has neither `title` nor a heading. */
	filename?: string;
}

export const parseNoteFile = (
	source: string,
	options: ParseNoteFileOptions = {}
): ParsedNoteFile => {
	const { frontmatter, body } = splitFrontmatter(source);
	const fields = readFrontmatter(frontmatter);

	return {
		...(fields.id === undefined ? {} : { id: fields.id }),
		...(fields.created === undefined ? {} : { created: fields.created }),
		...(fields.updated === undefined ? {} : { updated: fields.updated }),
		title: deriveTitle({
			frontmatterTitle: fields.title,
			body,
			filename: options.filename,
		}),
		body,
		frontmatter,
		tags: fields.tags ?? [],
	};
};

export interface SerializeNoteFileInput {
	/** The file's existing frontmatter, so unknown keys and comments survive. */
	frontmatter: string | null;
	body: string;
	/** Fields to write. Anything omitted is left as it was. */
	metadata: NoteFrontmatter;
}

/**
 * Write a note back to a file. The app adds frontmatter on first write; on every
 * write after that it edits the block in place, so keys it does not understand
 * are preserved.
 */
/** A body that already begins with a line break, in any of the three spellings. */
const OPENS_BLANK = /^(?:\r\n|\n|\r)/;

export const serializeNoteFile = (input: SerializeNoteFileInput): string => {
	const yaml = writeFrontmatter(input.frontmatter, input.metadata);
	if (yaml === '') return input.body;

	// The block is written the way this file writes lines, so the app never adds
	// a second style to a file that already had one: an `\n` fence above a CRLF
	// body is a shape no tool authors, and every line of it reads as changed to
	// anything comparing line by line.
	//
	// The body answers first, because it is the half a person edits — once it
	// has been through an editor it is `\n`, and the block follows it rather
	// than holding the file back at what it was. A body with no line ending at
	// all (empty, or one line with no trailing newline) has no answer, and then
	// the block's interior endings are asked instead.
	//
	// Both can be silent, and then this settles for `\n`. A block has interior
	// endings only if it holds two or more keys, so the gap is a CRLF note with
	// exactly one key *and* a body with no line ending: renaming it rewrites the
	// four lines of the file as `\n`. Closing it properly means carrying the
	// ending the fences had, which only `splitFrontmatter` ever sees and nothing
	// stores — a wider change than the shape is worth. Bounded and known, not
	// unnoticed.
	//
	// What is *not* asked is whether a CRLF appears anywhere in the body. One
	// inside a fenced code block is content, not the file's style, and letting
	// it vote turns a `\n` file into a CRLF one over a single byte of a code
	// sample.
	const ending = firstLineEnding(input.body) ?? firstLineEnding(input.frontmatter ?? '') ?? '\n';

	// A file that is gaining frontmatter for the first time gets the customary
	// blank line after the closing fence; one that already had a block keeps
	// whatever separator it already had, since body includes it verbatim.
	const separator = input.frontmatter === null && !OPENS_BLANK.test(input.body) ? ending : '';

	// The body goes through untouched. This writes the frontmatter block; it is
	// not a normalizer, and a note nobody edited comes back byte for byte.
	return withLineEnding(joinFrontmatter(yaml, ''), ending) + separator + input.body;
};
