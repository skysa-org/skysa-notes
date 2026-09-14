import { NOTE_EXTENSION } from '../config.js';

/**
 * Filenames are a slug of the title; `id` in frontmatter is the stable identity,
 * so renaming a file is safe. See docs/PLAN.md §3.
 */

/** Illegal or hostile in a filename on Windows, macOS, or a provider API. */
const UNSAFE = /[/\\:*?"<>|#%{}^[\]`~$&+=;@!'()]/g;

/** C0 and C1 control characters, which no provider accepts in a name. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Reserved device names on Windows, which several providers also reject. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Filename for a note with no usable title yet. */
export const UNTITLED_SLUG = 'untitled';

/**
 * Long enough for any reasonable title, short enough to leave room for a
 * conflict suffix inside the 255-byte limit every provider enforces.
 */
const MAX_SLUG_LENGTH = 120;

/**
 * Lowercase, hyphen-separated, safe on every provider. Non-Latin scripts are
 * kept rather than transliterated: a note titled in Japanese should not become
 * `untitled`.
 */
const toSlug = (title: string): string =>
	title
		.normalize('NFC')
		.toLowerCase()
		.replace(CONTROL, ' ')
		.replace(UNSAFE, ' ')
		// Whitespace and the punctuation people use as separators all collapse to
		// a single hyphen.
		.replace(/[\s._,-]+/g, '-')
		// A leading dot hides the file; trailing dots and spaces are stripped
		// silently by Windows, which would desynchronize the path we think we wrote.
		.replace(/^[-.\s]+|[-.\s]+$/g, '')
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, '');

export const slugify = (title: string): string => {
	const slug = toSlug(title);
	if (slug === '') return UNTITLED_SLUG;
	return RESERVED.test(slug) ? `${slug}-note` : slug;
};

/**
 * Same character rules, but a tag with nothing usable in it is dropped rather
 * than replaced by a placeholder — an empty tag is not a tag called `untitled`,
 * and a tag is not a filename, so reserved device names need no suffix here.
 */
export const normalizeTag = (tag: string): string | undefined => toSlug(tag) || undefined;

/**
 * Folder names are the notebook names the user typed, and every provider
 * accepts spaces and capitals in a directory name — so unlike a note filename,
 * which is derived from a title, this only removes what would actually break.
 * See docs/PLAN.md §3.
 */
export const sanitizeFolderName = (name: string): string => {
	const cleaned = name
		.normalize('NFC')
		.replace(CONTROL, ' ')
		.replace(UNSAFE, ' ')
		.replace(/\s+/g, ' ')
		// A leading dot hides the folder; trailing dots and spaces are stripped
		// silently by Windows, desynchronizing the path we think we wrote.
		.replace(/^[.\s]+|[.\s]+$/g, '')
		.slice(0, MAX_SLUG_LENGTH)
		.trim();

	if (cleaned === '') return 'Untitled';
	return RESERVED.test(cleaned) ? `${cleaned} folder` : cleaned;
};

/** The filename for a note with this title, extension included. */
export const noteFilename = (title: string): string => `${slugify(title)}${NOTE_EXTENSION}`;

/**
 * Disambiguate against names already in the folder by appending `-2`, `-3`, and
 * so on — the convention every file manager uses. Comparison is
 * case-insensitive because Drive, Dropbox, and macOS all treat names that way.
 */
const nextFreeName = (base: string, used: ReadonlySet<string>, n: number): string => {
	const candidate = n === 1 ? `${base}${NOTE_EXTENSION}` : `${base}-${n}${NOTE_EXTENSION}`;
	return used.has(candidate.toLowerCase()) ? nextFreeName(base, used, n + 1) : candidate;
};

export const uniqueFilename = (title: string, taken: Iterable<string>): string =>
	nextFreeName(slugify(title), new Set([...taken].map((name) => name.toLowerCase())), 1);
