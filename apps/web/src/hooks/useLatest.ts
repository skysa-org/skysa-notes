import { type RefObject, useEffect, useRef } from 'react';

/**
 * A ref that holds the last `value` rendered, for a callback or a value read
 * later — in an editor's handler, a timer, an effect that must not re-run on
 * it — without being stale (#457). Written after the render that brought it,
 * as the twenty-one copies of this it replaced wrote it.
 *
 * Read `.current` where it is used, never once at render: what a render reads
 * is the value before it.
 */
export const useLatest = <T>(value: T): Readonly<RefObject<T>> => {
	const latest = useRef(value);
	useEffect(() => {
		latest.current = value;
	}, [value]);
	return latest;
};
