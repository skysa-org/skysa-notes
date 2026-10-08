import { describe, expect, it, vi } from 'vitest';

import { nearestCopy, oneAtATime } from '../src/pictures/copies.js';
import type { PictureCopyRecord } from '../src/store/db.js';

/**
 * The order copies of pictures are made in, one at a time app-wide, and the
 * copy that stands in for one that cannot be made (#276).
 */

/** Work that ends when the test says, counting how often it was started. */
const deferred = <T>(value: T) => {
	const started = { current: 0 };
	const finish = { current: (): void => undefined };
	const work = vi.fn(
		() =>
			new Promise<T>((resolve) => {
				started.current += 1;
				finish.current = () => {
					resolve(value);
				};
			})
	);
	return { work, started, finish: () => finish.current() };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const asking = () => new AbortController().signal;

describe('work done one piece at a time', () => {
	it('starts each piece once the one before has ended, in the order asked', async () => {
		const turns = oneAtATime<string>();
		const first = deferred('a');
		const second = deferred('b');

		const a = turns('a', asking(), first.work);
		const b = turns('b', asking(), second.work);
		await settled();
		expect(first.started.current).toBe(1);
		expect(second.started.current).toBe(0);

		first.finish();
		expect(await a).toBe('a');
		await settled();
		expect(second.started.current).toBe(1);
		second.finish();
		expect(await b).toBe('b');
	});

	it('joins work already asked for under the same key, waiting or under way', async () => {
		const turns = oneAtATime<string>();
		const ahead = deferred('ahead');
		const copy = deferred('copy');
		const again = vi.fn(() => Promise.resolve('again'));

		void turns('ahead', asking(), ahead.work);
		const waiting = turns('cat', asking(), copy.work);
		const joined = turns('cat', asking(), again);
		await settled();
		ahead.finish();
		await settled();
		const underWay = turns('cat', asking(), again);
		copy.finish();

		expect(await Promise.all([waiting, joined, underWay])).toEqual(['copy', 'copy', 'copy']);
		expect(copy.work).toHaveBeenCalledTimes(1);
		expect(again).not.toHaveBeenCalled();
	});

	it('passes over work nobody waits for by its turn, and finishes work under way', async () => {
		const turns = oneAtATime<string>();
		const ahead = deferred('ahead');
		const passed = vi.fn(() => Promise.resolve('passed'));
		const leaving = new AbortController();
		const staying = new AbortController();

		const first = turns('ahead', staying.signal, ahead.work);
		const second = turns('cat', leaving.signal, passed);
		await settled();
		leaving.abort();
		staying.abort();
		ahead.finish();

		expect(await first).toBe('ahead');
		expect(await second).toBeUndefined();
		expect(passed).not.toHaveBeenCalled();
	});

	it('keeps work joined by one still waiting, when another stops', async () => {
		const turns = oneAtATime<string>();
		const ahead = deferred('ahead');
		const copy = vi.fn(() => Promise.resolve('copy'));
		const leaving = new AbortController();

		void turns('ahead', asking(), ahead.work);
		const gone = turns('cat', leaving.signal, copy);
		const still = turns('cat', asking(), copy);
		leaving.abort();
		await settled();
		ahead.finish();

		expect(await still).toBe('copy');
		expect(await gone).toBe('copy');
		expect(copy).toHaveBeenCalledTimes(1);
	});

	it('takes nothing on for one that has stopped waiting already', async () => {
		const turns = oneAtATime<string>();
		const stopped = new AbortController();
		stopped.abort();
		const work = vi.fn(() => Promise.resolve('copy'));

		expect(await turns('cat', stopped.signal, work)).toBeUndefined();
		expect(work).not.toHaveBeenCalled();
	});

	it('goes on past work that failed, which fails for whoever waited on it', async () => {
		const turns = oneAtATime<string>();
		const failed = turns('a', asking(), () => Promise.reject(new Error('no')));
		const next = turns('b', asking(), () => Promise.resolve('b'));

		await expect(failed).rejects.toThrow('no');
		expect(await next).toBe('b');
	});

	it('starts again under a key whose work has ended', async () => {
		const turns = oneAtATime<number>();
		const count = { current: 0 };
		const work = () => Promise.resolve((count.current += 1));

		expect(await turns('cat', asking(), work)).toBe(1);
		expect(await turns('cat', asking(), work)).toBe(2);
	});
});

describe('the copy that stands in for one that cannot be had', () => {
	const copy = (width: number): PictureCopyRecord => ({
		type: 'image/webp',
		width,
		height: width / 2,
		size: width,
		lastUsedAt: 0,
	});

	it('is the narrowest at least as wide as the one wanted, and else the widest', () => {
		const copies = { thumb: copy(512), w960: copy(960), w1920: copy(1920) };

		expect(nearestCopy(copies, 1280)).toBe('w1920');
		expect(nearestCopy(copies, 960)).toBe('w960');
		expect(nearestCopy(copies, 400)).toBe('thumb');
		expect(nearestCopy(copies, 2560)).toBe('w1920');
		expect(nearestCopy({}, 960)).toBeUndefined();
	});
});
