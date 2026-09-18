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

/**
 * A surrogate with no partner. With the `u` flag a paired surrogate is read as
 * its code point, so this matches only the broken ones. A title can arrive
 * holding one — pasted, or cut by some other tool's truncation — and a name
 * that is not well-formed UTF-16 makes `encodeURIComponent` throw `URIError`
 * inside a provider adapter: a counted failure, on an op queue that is ordered.
 */
const LONE_SURROGATE = /\p{Surrogate}/gu;

/**
 * Reserved device names on Windows, which several providers also reject.
 *
 * `COM1`–`COM9` and `LPT1`–`LPT9`, and the superscript digits with them:
 * Windows reads the ISO 8859-1 characters `\u00b9`, `\u00b2` and `\u00b3` as
 * digits here, so `COM\u00b9` is as reserved as `COM1`.
 * https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
 *
 * `COM0` and `LPT0` are not on that page and are on OneDrive's, which refuses
 * "COM0 - COM9, LPT0 - LPT9" by name.
 * https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa
 */
const RESERVED = /^(con|prn|aux|nul|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])$/i;

/** Filename for a note with no usable title yet. */
export const UNTITLED_SLUG = 'untitled';

/**
 * Two caps, and a name has to fit both.
 *
 * Code points, because that is what a person would call the length: long
 * enough for any reasonable title.
 *
 * Bytes, because that is what a filesystem counts. ext4 and APFS allow a name
 * 255 bytes of UTF-8, and the folder does reach one: the provider's own desktop
 * client syncs it to a local disk. 120 characters says nothing about that —
 * 120 CJK characters are 360 bytes.
 *
 * The byte cap is what lets a name this app chose take one conflict suffix
 * whole. Beside the stem, in the 255:
 *
 *   ` (conflict 2026-09-15T14-32)`   28   `conflictFilename` in sync/conflicts.ts
 *   `.md`                             3
 *   `-999`                            4   `uniqueFilename`, telling two titles apart
 *   `-999`                            4   the same, for two conflicts in one minute
 *
 * 255 - 39 = 216. It promises nothing past that: a copy of a copy carries two
 * suffixes, and a name another tool chose was never capped at all. The 255 is
 * kept where those names are made — `conflictName` cuts the stem to fit, with
 * `fitBytes` below — and this cap is only why it seldom has to.
 */
const MAX_SLUG_CODE_POINTS = 120;
const MAX_SLUG_BYTES = 216;

/** What ext4 and APFS allow one name, in bytes of UTF-8. */
export const MAX_NAME_BYTES = 255;

export const utf8Length = (text: string): number =>
	[...text].reduce((bytes, char) => {
		const point = char.codePointAt(0) ?? 0;
		if (point < 0x80) return bytes + 1;
		if (point < 0x800) return bytes + 2;
		return bytes + (point < 0x10000 ? 3 : 4);
	}, 0);

/**
 * Where there is no `Intl.Segmenter` (Firefox before 125): a base character
 * with its combining marks, carried across any zero-width joiner. It does not
 * know a flag or a skin-tone modifier from two characters, and what it gets
 * wrong is a cut in an odd place, never a malformed string.
 */
const APPROXIMATE_CLUSTER = /\p{M}+|\P{M}\p{M}*(?:\u200d\P{M}\p{M}*)*/gu;

/**
 * What a reader would call the characters: an emoji joined from four code
 * points is one, and so is a letter with the accents stacked on it.
 */
const clusters = (text: string): readonly string[] => {
	// Asked on every call rather than once, and of the value rather than the
	// type: the lib says it is always there, and it is not.
	const segmenter = (Intl as Partial<typeof Intl>).Segmenter;
	return segmenter === undefined
		? (text.match(APPROXIMATE_CLUSTER) ?? [])
		: Array.from(
				new segmenter(undefined, { granularity: 'grapheme' }).segment(text),
				(each) => each.segment
			);
};

interface Fit {
	readonly text: string;
	readonly points: number;
	readonly bytes: number;
	readonly full: boolean;
}

interface Caps {
	readonly points: number;
	readonly bytes: number;
}

const SLUG_CAPS: Caps = { points: MAX_SLUG_CODE_POINTS, bytes: MAX_SLUG_BYTES };

/**
 * Cut to both caps without cutting a character in half.
 *
 * `slice` counts UTF-16 units, and a cut landing inside a surrogate pair leaves
 * half of one at the end of the name — see `LONE_SURROGATE` for what that
 * costs. Cutting between code points avoids that and still turns a family
 * emoji into a different one, or strands an accent's letter, so the cut is made
 * between clusters.
 *
 * A single cluster too big for the caps on its own — text with marks piled on
 * one letter by the hundred — is cut between code points instead, or the whole
 * name would be dropped for it.
 */
const cut = (text: string, caps: Caps): string => {
	const fits = (points: number, bytes: number): boolean =>
		points <= caps.points && bytes <= caps.bytes;

	return clusters(text)
		.flatMap((cluster) =>
			fits([...cluster].length, utf8Length(cluster)) ? [cluster] : [...cluster]
		)
		.reduce<Fit>(
			(fit, piece) => {
				if (fit.full) return fit;
				const points = fit.points + [...piece].length;
				const bytes = fit.bytes + utf8Length(piece);
				return fits(points, bytes)
					? { text: fit.text + piece, points, bytes, full: false }
					: { ...fit, full: true };
			},
			{ text: '', points: 0, bytes: 0, full: false }
		).text;
};

const truncate = (text: string): string => cut(text, SLUG_CAPS);

/**
 * As much of the start of `text` as fits in `bytes` of UTF-8, cut the same way.
 * Text that fits comes back untouched, which is nearly always.
 */
export const fitBytes = (text: string, bytes: number): string =>
	utf8Length(text) <= bytes ? text : cut(text, { points: Infinity, bytes });

/**
 * Lowercase, hyphen-separated, safe on every provider. Non-Latin scripts are
 * kept rather than transliterated: a note titled in Japanese should not become
 * `untitled`.
 */
const toSlug = (title: string): string =>
	truncate(
		title
			.normalize('NFC')
			.toLowerCase()
			.replace(LONE_SURROGATE, ' ')
			.replace(CONTROL, ' ')
			.replace(UNSAFE, ' ')
			// Whitespace and the punctuation people use as separators all collapse to
			// a single hyphen.
			.replace(/[\s._,-]+/g, '-')
			// A leading dot hides the file; trailing dots and spaces are stripped
			// silently by Windows, which would desynchronize the path we think we wrote.
			.replace(/^[-.\s]+|[-.\s]+$/g, '')
	).replace(/-+$/, '');

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
	const cleaned = truncate(
		name
			.normalize('NFC')
			.replace(LONE_SURROGATE, ' ')
			.replace(CONTROL, ' ')
			.replace(UNSAFE, ' ')
			.replace(/\s+/g, ' ')
			// A leading dot hides the folder; trailing dots and spaces are stripped
			// silently by Windows, desynchronizing the path we think we wrote.
			.replace(/^[.\s]+|[.\s]+$/g, '')
		// Again, for whatever the cut left at the end.
	).replace(/[.\s]+$/, '');

	if (cleaned === '') return 'Untitled';
	return RESERVED.test(cleaned) ? `${cleaned} folder` : cleaned;
};

/** The filename for a note with this title, extension included. */
export const noteFilename = (title: string): string => `${slugify(title)}${NOTE_EXTENSION}`;

/**
 * Two names are the same name when the provider says they are: case-folded and
 * NFC-normalized, because Drive, Dropbox and macOS all treat them that way.
 *
 * The one place that answers this question, exported so that it stays the one
 * place. Every check that asks whether a name is taken guards a renamer that
 * asks the same thing, and the two have to agree: where they disagree it is
 * always the check that fails open, handing back the very name it was asked to
 * avoid — one file on the provider, under two names nothing here can tell
 * apart. Four separate bugs of that shape came from two copies of this
 * drifting.
 *
 * Both folds, not just case. `slugify` normalizes what it produces, so a taken
 * set folded by case alone misses a name that arrived as NFD.
 */
export const foldName = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * Disambiguate against names already in the folder by appending `-2`, `-3`, and
 * so on — the convention every file manager uses.
 */
const nextFreeName = (base: string, used: ReadonlySet<string>, n: number): string => {
	const candidate = n === 1 ? `${base}${NOTE_EXTENSION}` : `${base}-${n}${NOTE_EXTENSION}`;
	return used.has(foldName(candidate)) ? nextFreeName(base, used, n + 1) : candidate;
};

export const uniqueFilename = (title: string, taken: Iterable<string>): string =>
	nextFreeName(slugify(title), new Set([...taken].map(foldName)), 1);
