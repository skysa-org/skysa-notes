import type { PictureVariant } from '@skysa/core';

import type { PictureRecord } from '../store/db.js';

/**
 * How the app gets copies of pictures to show (#276): the order they are made
 * in, and which copy stands in for one that cannot be made.
 */

/**
 * Work done one piece at a time, app-wide, in the order it was asked for, with
 * each piece started only at its turn. Making a copy reads the whole original
 * into memory, and a phone holding forty originals while each waits its turn
 * holds forty pictures at once, which is what copies are for not doing.
 *
 * Work under a key already waiting, or under way, is joined rather than asked
 * for again: a view that asks again — the network came back — finds the copy
 * it asked for before. Work whose askers have all stopped waiting by its turn
 * is passed over, and comes to `undefined`. Work under way is finished, and
 * what it makes is kept, whoever is still waiting.
 */
export type Turns<T> = (
	key: string,
	signal: AbortSignal,
	work: () => Promise<T>
) => Promise<T | undefined>;

export const oneAtATime = <T>(): Turns<T> => {
	const queue: { current: Promise<unknown> } = { current: Promise.resolve() };
	const waiting = new Map<
		string,
		{ askers: { current: number }; done: Promise<T | undefined> }
	>();
	const start = (key: string, work: () => Promise<T>) => {
		const askers = { current: 0 };
		const done = queue.current
			.then(() => (askers.current > 0 ? work() : undefined))
			.finally(() => {
				if (waiting.get(key)?.askers === askers) waiting.delete(key);
			});
		queue.current = done.catch(() => undefined);
		const entry = { askers, done };
		waiting.set(key, entry);
		return entry;
	};
	return (key, signal, work) => {
		if (signal.aborted) return Promise.resolve(undefined);
		const entry = waiting.get(key) ?? start(key, work);
		entry.askers.current += 1;
		signal.addEventListener(
			'abort',
			() => {
				entry.askers.current -= 1;
			},
			{ once: true }
		);
		return entry.done;
	};
};

/**
 * The copy the device holds to show where the one wanted cannot be had now —
 * the original is not here, and the network is not, or it is too large to
 * download unasked: the narrowest at least `width` wide, and else the widest.
 * A copy of another size beats none.
 */
export const nearestCopy = (
	copies: PictureRecord['copies'],
	width: number
): PictureVariant | undefined => {
	const held = Object.entries(copies)
		.map(([variant, copy]) => ({ variant: variant as PictureVariant, width: copy.width }))
		.toSorted((a, b) => a.width - b.width);
	return (held.find((copy) => copy.width >= width) ?? held.at(-1))?.variant;
};
