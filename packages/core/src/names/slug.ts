import { NOTE_EXTENSION } from '../config.js';
import { extensionForType, isImageExtension } from '../files/mediaTypes.js';
import { type Caps, cut, fitBytes, MAX_NAME_BYTES } from './bytes.js';
import { extensionAt } from './extension.js';
import { foldName } from './fold.js';

/**
 * Filenames are a slug of the title; `id` in frontmatter is the stable identity,
 * so renaming a file is safe. See docs/ARCHITECTURE.md §3.
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
 *   ` (conflict 2026-09-15T14-32)`   28   `conflictFilename` in names/conflicts.ts
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

const SLUG_CAPS: Caps = { points: MAX_SLUG_CODE_POINTS, bytes: MAX_SLUG_BYTES };

const truncate = (text: string): string => cut(text, SLUG_CAPS);

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
 * See docs/ARCHITECTURE.md §3.
 *
 * `unnamed` is the name for one with nothing usable in it: a word in the
 * user's language, which the app gives (docs/ARCHITECTURE.md §7, "The app's
 * words").
 */
export const sanitizeFolderName = (name: string, unnamed = 'Untitled'): string => {
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

	if (cleaned === '') return unnamed;
	return RESERVED.test(cleaned) ? `${cleaned} folder` : cleaned;
};

/** The filename for a note with this title, extension included. */
export const noteFilename = (title: string): string => `${slugify(title)}${NOTE_EXTENSION}`;

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

/**
 * A file's own name, as the user gave it, but for what would break on a
 * provider or a disk: the characters a notebook's name loses
 * (`sanitizeFolderName`), so its spaces and capitals stay.
 */
const keptStem = (stem: string): string =>
	stem
		.normalize('NFC')
		.replace(LONE_SURROGATE, ' ')
		.replace(CONTROL, ' ')
		.replace(UNSAFE, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * The stem's share of an attachment's name, in bytes: the 255 a filesystem
 * allows, less a conflict suffix and its counter (28 + 4), less `-` and a hash
 * of up to 16 hex (17), less `.` and an extension of up to 16 (17).
 */
const ATTACHMENT_STEM_BYTES = MAX_NAME_BYTES - 32 - 17 - 17;

/**
 * The name a file is stored under beside a note: `<slug of its name>-<hash>.<ext>`
 * — `q3-report-3f9a1c2b.pdf` — or `pasted-image-3f9a1c2b.png` for a picture
 * from the clipboard, whose own name (`image.png`) says nothing; a file that is
 * not a picture keeps its name however it arrived. `hash` is the hex of the
 * file's SHA-256 (`bytesHash`); its first eight characters name it, or up to
 * sixteen (`hashLength`) where eight are already taken by a different file.
 * Anything else is a `RangeError`: the hash goes into a path, and a longer one
 * would eat the room a conflict suffix is promised.
 *
 * Stamped with the content (docs/ARCHITECTURE.md §3, #187): the same file
 * added twice, or on two devices, is one name and one file, and a name that is
 * taken by a file of another size is the rare case rather than the common one.
 * The name the user knows the file by is in the link, not here, so nothing is
 * renamed when they rename it there.
 *
 * The extension is the name's own, folded, where it is plain letters and
 * digits, and from `type` where it is not. `undefined` for `.md`: a file by
 * that name is a note to every device that pulls it.
 *
 * `kept`: the stem as the user gave it (`keptStem`) rather than its slug, for
 * a file known by the name it is stored under — a clipboard item, which has
 * no link to hold its name (2026-10-14).
 */
export const attachmentName = ({
	name,
	hash,
	type = '',
	pasted = false,
	hashLength = 8,
	kept = false,
}: {
	name: string;
	hash: string;
	type?: string;
	pasted?: boolean;
	hashLength?: number;
	kept?: boolean;
}): string | undefined => {
	if (!Number.isInteger(hashLength) || hashLength < 8 || hashLength > 16) {
		throw new RangeError(
			`an attachment's name takes 8 to 16 hex of its hash, not ${hashLength}`
		);
	}
	if (!new RegExp(`^[0-9a-f]{${hashLength},}$`, 'i').test(hash)) {
		throw new RangeError('an attachment is named by the hex of its hash');
	}
	const at = extensionAt(name);
	const own = foldName(name.slice(at + 1));
	const media = type.split(';')[0]?.trim().toLowerCase() ?? '';
	const extension = /^[a-z0-9]{1,16}$/.test(own) ? own : (extensionForType(media) ?? 'bin');
	if (`.${extension}` === NOTE_EXTENSION) return undefined;

	const nameless = pasted && isImageExtension(extension);
	const given = nameless ? '' : name.slice(0, at);
	const fitted = fitBytes(kept ? keptStem(given) : toSlug(given), ATTACHMENT_STEM_BYTES);
	// What a cut leaves at the end: a space, or a slug's hyphen.
	const stem =
		fitted.replace(kept ? /\s+$/ : /-+$/, '') || (nameless ? 'pasted-image' : 'attachment');
	return `${stem}-${hash.slice(0, hashLength).toLowerCase()}.${extension}`;
};
