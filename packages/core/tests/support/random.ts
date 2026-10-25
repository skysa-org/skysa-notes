/**
 * mulberry32: small, seedable, and the same on every machine, so a test put
 * together at random fails the same way everywhere and can name the seed it
 * came from. https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
export const mulberry32 = (seed: number): (() => number) => {
	const state = { value: seed >>> 0 };
	return () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0;
		const t1 = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
		const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
		return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
	};
};
