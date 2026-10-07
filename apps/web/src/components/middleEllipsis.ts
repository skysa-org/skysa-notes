import { clusters } from '@skysa/core';

/**
 * Text shortened in its middle rather than at its end, for a notebook's path,
 * whose end is the part that says where the user is: `Work/Proj…/Q3`, where
 * cut at the end it was `Work/Proj…`. CSS has no middle ellipsis, and the two
 * halves cut by the stylesheet left a gap after the first ellipsis, up to a
 * letter wide, so it is worked out here against a measure the caller gives.
 */

export const ELLIPSIS = '…';

/**
 * The largest count from `low` to `high` that `fits`, or undefined when not
 * even `low` does. A count is taken to fit wherever a larger one does, as
 * text does when it loses characters.
 */
const most = (low: number, high: number, fits: (count: number) => boolean): number | undefined => {
	if (low > high || !fits(low)) return undefined;
	const between = (fit: number, over: number): number => {
		if (over - fit <= 1) return fit;
		const middle = Math.floor((fit + over) / 2);
		return fits(middle) ? between(middle, over) : between(fit, middle);
	};
	return fits(high) ? high : between(low, high);
};

const cut = (start: readonly string[], end: readonly string[]): string =>
	`${start.join('').trimEnd()}${ELLIPSIS}${end.join('').trimStart()}`;

/**
 * `text` as long as `fits` allows it, with what is left out of its middle
 * said by one ellipsis. Its end, `keep`, stays whole for as long as any of
 * the start can stand before it — `Work/Projects/Q3`, then `Work/Proj…/Q3`,
 * then `W…/Q3`. Past that both ends give way, the end keeping twice as much
 * as the start, since the end is the notebook's own name.
 *
 * Cut between what a reader would call characters (`clusters`), so never
 * through an emoji or an accented letter. Where nothing fits, the shortest it
 * makes, for the box to clip.
 */
export const middleEllipsis = (
	text: string,
	keep: string,
	fits: (shortened: string) => boolean
): string => {
	if (fits(text)) return text;
	const all = clusters(text);
	const kept = clusters(keep);
	const head = all.slice(0, all.length - kept.length);
	const withEnd = most(1, head.length - 1, (count) => fits(cut(head.slice(0, count), kept)));
	if (withEnd !== undefined) return cut(head.slice(0, withEnd), kept);
	const ends = (count: number): string => {
		const start = Math.max(1, Math.floor(count / 3));
		return cut(all.slice(0, start), all.slice(all.length - (count - start)));
	};
	return ends(most(2, all.length - 1, (count) => fits(ends(count))) ?? 2);
};
