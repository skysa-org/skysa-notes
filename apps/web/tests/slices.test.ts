import { afterEach, describe, expect, it, vi } from 'vitest';

import { eachInSlices } from '../src/store/slices.js';

/**
 * Work over a whole library, a slice at a time (`store/slices.ts`), so a key
 * pressed meanwhile waits for one slice and not for all of it (#275).
 */
describe('work done a slice at a time', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A clock a millisecond on each time it is read, so a slice holds a few items. */
	const ticking = () => {
		const clock = { now: 0 };
		vi.spyOn(performance, 'now').mockImplementation(() => (clock.now += 1));
	};

	const counting = (count: number) => Array.from({ length: count }, (__, at) => at);

	it('does every item, in order, handing the thread back between slices', async () => {
		ticking();
		const done: number[] = [];

		const working = eachInSlices(counting(40), (item) => {
			done.push(item);
		});
		// The first slice before it returned, and only that: the rest wait for
		// the event loop to come round.
		const first = done.length;
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(40);

		await working;
		expect(done).toEqual(counting(40));
	});

	it('lets what is waiting go between slices', async () => {
		ticking();
		const order: string[] = [];
		const waiting = new Promise<void>((resolve) => {
			setTimeout(() => {
				order.push('waiting');
				resolve();
			}, 0);
		});

		// Enough slices that the timer is due before the last of them, however
		// fast they run: hundreds of turns of the event loop.
		await eachInSlices(counting(4000), (item) => {
			if (item === 0 || item === 3999) order.push(String(item));
		});
		await waiting;

		expect(order).toEqual(['0', 'waiting', '3999']);
	});

	it('is done before it returns when it fits in a slice', () => {
		vi.spyOn(performance, 'now').mockReturnValue(0);
		const done: number[] = [];

		void eachInSlices(counting(3), (item) => {
			done.push(item);
		});

		expect(done).toEqual(counting(3));
	});

	it('hands the thread back every few hundred items, however fast they go', async () => {
		// A clock that never moves: no slice ever runs out of time.
		vi.spyOn(performance, 'now').mockReturnValue(0);
		const done: number[] = [];

		const working = eachInSlices(counting(1000), (item) => {
			done.push(item);
		});
		const first = done.length;
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(1000);

		await working;
		expect(done).toEqual(counting(1000));
	});

	it('does nothing for nothing', async () => {
		const work = vi.fn();

		await eachInSlices([], work);

		expect(work).not.toHaveBeenCalled();
	});
});
