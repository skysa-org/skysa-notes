import { createEmitter } from '../../store/emitter.js';

/**
 * Which editor is open now, for whatever outside it has to reach it: the find
 * bar, a picked file, "Insert secret".
 *
 * Every editor that has offered itself and not gone, in the order they offered;
 * the last is the one open now. More than one only while one editor is giving
 * way to another, and that can go either way round: the new one can be built
 * before the old one has gone, and a rich editor still being built when it is
 * let go of is built — and offers itself — before it goes. So taking one away
 * never takes the others with it, and leaves the one that offered last before it.
 */
export interface Offers<T> {
	/** Offer this editor's; the returned function takes it away again. */
	readonly offer: (item: T) => () => void;
	readonly current: () => T | undefined;
	/** Told when the answer to `current` may have changed. */
	readonly subscribe: (listener: () => void) => () => void;
}

export const createOffers = <T>(): Offers<T> => {
	// Each offer an entry of its own, so that one item offered twice is taken
	// away once for each.
	const offered = new Set<Readonly<{ item: T }>>();
	const changes = createEmitter();
	return {
		offer: (item) => {
			const entry = { item };
			offered.add(entry);
			changes.emit();
			return () => {
				if (offered.delete(entry)) changes.emit();
			};
		},
		current: () => [...offered].at(-1)?.item,
		subscribe: changes.subscribe,
	};
};
