import {
	joinFrontmatter,
	type NoteFrontmatter,
	readFrontmatter,
	splitFrontmatter,
	writeFrontmatter,
} from './frontmatter.js';
import { deriveTitle } from './title.js';

/**
 * A note file, read into its parts. The markdown string is the only source of
 * truth; this is a view of it, not a replacement. Reading a file never changes
 * it — `parseNoteFile` adds nothing and normalizes nothing, so a note authored
 * elsewhere keeps its own formatting until someone actually edits it.
 * See docs/PLAN.md §7.
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
export const serializeNoteFile = (input: SerializeNoteFileInput): string => {
	const yaml = writeFrontmatter(input.frontmatter, input.metadata);
	if (yaml === '') return input.body;

	// A file that is gaining frontmatter for the first time gets the customary
	// blank line after the closing fence; one that already had a block keeps
	// whatever separator it already had, since body includes it verbatim.
	const body =
		input.frontmatter === null && !input.body.startsWith('\n') ? `\n${input.body}` : input.body;

	return joinFrontmatter(yaml, body);
};
