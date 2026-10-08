import type { PictureVariant } from '@skysa/core';

import type { PictureRecord } from '../store/db.js';
import type { PictureShrinker } from './shrinker.js';

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
		const over = () => {
			if (waiting.get(key)?.askers === askers) waiting.delete(key);
		};
		const done = queue.current
			.then(() => {
				if (askers.current > 0) return work();
				// Gone at once: one who asks between here and the `finally`
				// starts the work afresh, rather than joining work passed over.
				over();
				return undefined;
			})
			.finally(over);
		// The order alone. What the work came to is its askers': held here, the
		// last copy made would keep the original it was made from for as long
		// as the app is open.
		queue.current = done.then(
			() => undefined,
			() => undefined
		);
		const entry = { askers, done };
		waiting.set(key, entry);
		return entry;
	};
	return (key, signal, work) => {
		if (signal.aborted) return Promise.resolve(undefined);
		const entry = waiting.get(key) ?? start(key, work);
		entry.askers.current += 1;
		const stop = () => {
			entry.askers.current -= 1;
		};
		signal.addEventListener('abort', stop, { once: true });
		// Taken off once the work is done. A view's signal lasts as long as the
		// view, and what the work came to, held by it, would last as long.
		const off = () => {
			signal.removeEventListener('abort', stop);
		};
		void entry.done.then(off, off);
		return entry.done;
	};
};

const turnsOf = new WeakMap<PictureShrinker, Turns<unknown>>();

/**
 * The one order copies are made in by `shrinker`, which for the app is one: a
 * note's editor, the scratch cards and the clipboard wait for one another, so
 * only one original is read for a copy at a time (`oneAtATime`). Each asker's
 * keys are its own — the clipboard's begin `clip` — so none joins another's
 * work, and what each is answered is what its own work made.
 */
export const copyTurns = <T>(shrinker: PictureShrinker): Turns<T> => {
	const turns = turnsOf.get(shrinker) ?? oneAtATime<unknown>();
	turnsOf.set(shrinker, turns);
	return turns as Turns<T>;
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
