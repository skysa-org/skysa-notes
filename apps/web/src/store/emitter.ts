import { cell } from '@skysa/core';
/**
 * The two halves of every store the UI reads through `useSyncExternalStore`,
 * written once (#457): being told of a change, and a value that tells of its
 * own. Fifteen modules wrote the listener set and its loop out by hand.
 *
 * A listener that throws stops the ones after it and reaches whoever made the
 * change, as it always did here. A store whose listeners must not do that tells
 * them its own way (`store/heldUp.ts`).
 */

export interface Emitter {
	/** Be told of each change. Returns the way to stop. */
	readonly subscribe: (listener: () => void) => () => void;
	/** Tell everyone listening, in the order they began. */
	readonly emit: () => void;
}

export const createEmitter = (): Emitter => {
	const listeners = new Set<() => void>();
	return {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit: () => {
			listeners.forEach((listener) => {
				listener();
			});
		},
	};
};

export interface Store<T> {
	readonly get: () => T;
	/** Hold `next`, and say so, unless it `equals` what is held. */
	readonly set: (next: T) => void;
	readonly subscribe: Emitter['subscribe'];
}

/**
 * A value that tells its listeners when it changes. A value `equals` the one
 * held is no change, and tells nobody: by identity unless told otherwise, which
 * is also how `useSyncExternalStore` compares what `get` hands it.
 */
export const createStore = <T>(
	initial: T,
	equals: (held: T, next: T) => boolean = Object.is
): Store<T> => {
	const held = cell(initial);
	const { subscribe, emit } = createEmitter();
	return {
		get: () => held.current,
		set: (next) => {
			if (equals(held.current, next)) return;
			held.current = next;
			emit();
		},
		subscribe,
	};
};
