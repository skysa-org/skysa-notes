import { toString as nodeToString } from 'mdast-util-to-string';

import { NOTE_EXTENSION } from '../config.js';
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

const firstHeadingText = (body: string): string | undefined =>
	parse(body)
		.children.filter((node) => node.type === 'heading')
		.map((node) => nodeToString(node).trim())
		.find((text) => text !== '');

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

	return 'Untitled';
};
