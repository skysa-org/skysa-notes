/**
 * How long a name is where it is stored: in bytes of UTF-8, which is what a
 * filesystem counts, and in characters as a reader counts them, so a cut to
 * fit never splits one.
 */

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
export const clusters = (text: string): readonly string[] => {
	// Asked of the value rather than the type: the lib says it is always there,
	// and it is not.
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

export interface Caps {
	readonly points: number;
	readonly bytes: number;
}

/**
 * Cut to both caps without cutting a character in half.
 *
 * `slice` counts UTF-16 units, and a cut landing inside a surrogate pair leaves
 * half of one at the end of the name — see `LONE_SURROGATE` in `slug.ts` for
 * what that costs. Cutting between code points avoids that and still turns a
 * family emoji into a different one, or strands an accent's letter, so the cut
 * is made between clusters.
 *
 * A single cluster too big for the caps on its own — text with marks piled on
 * one letter by the hundred — is cut between code points instead, or the whole
 * name would be dropped for it.
 */
export const cut = (text: string, caps: Caps): string => {
	const fits = (points: number, bytes: number): boolean =>
		points <= caps.points && bytes <= caps.bytes;

	// Nearly every title, and every one slugged on each keystroke of a rename:
	// no UTF-16 unit is more than three bytes or more than one code point, so
	// text this short fits whatever is in it, and nothing need be segmented.
	if (fits(text.length, text.length * 3)) return text;

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

/**
 * As much of the start of `text` as fits in `bytes` of UTF-8, cut the same way.
 * Text that fits comes back untouched, which is nearly always.
 */
export const fitBytes = (text: string, bytes: number): string =>
	utf8Length(text) <= bytes ? text : cut(text, { points: Infinity, bytes });
