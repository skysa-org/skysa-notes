import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createObjectUrlCache, type ObjectUrlFactory } from '../src/editor/objectUrls.js';

const GRACE = 1000;

/** URLs as jsdom cannot make them: numbered, with every revoke recorded. */
const factory = () => {
	const made: Blob[] = [];
	const revoked: string[] = [];
	const urls: ObjectUrlFactory = {
		create: (blob) => {
			made.push(blob);
			return `blob:test/${String(made.length)}`;
		},
		revoke: (url) => {
			revoked.push(url);
		},
	};
	return { urls, made, revoked };
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('object URLs for the files beside a note', () => {
	it('is one URL per key however many views hold it, made from the blob only the first time', () => {
		const { urls, made } = factory();
		const cache = createObjectUrlCache(urls, GRACE);
		const blob = vi.fn(() => new Blob(['a']));

		const first = cache.acquire('c1/a', blob);
		const second = cache.acquire('c1/a', blob);

		expect(second.url).toBe(first.url);
		expect(blob).toHaveBeenCalledTimes(1);
		expect(made).toHaveLength(1);
		expect(cache.acquire('c1/b', () => new Blob(['b'])).url).not.toBe(first.url);
	});

	it('revokes a URL once nothing holds it, after the grace', () => {
		const { urls, revoked } = factory();
		const cache = createObjectUrlCache(urls, GRACE);
		const first = cache.acquire('c1/a', () => new Blob(['a']));
		const second = cache.acquire('c1/a', () => new Blob(['a']));

		first.release();
		vi.advanceTimersByTime(GRACE);
		expect(revoked).toEqual([]);
		second.release();
		vi.advanceTimersByTime(GRACE - 1);
		expect(revoked).toEqual([]);
		vi.advanceTimersByTime(1);

		expect(revoked).toEqual([first.url]);
	});

	it('keeps the same URL for a view rebuilt inside the grace', () => {
		const { urls, made, revoked } = factory();
		const cache = createObjectUrlCache(urls, GRACE);
		const old = cache.acquire('c1/a', () => new Blob(['a']));

		old.release();
		vi.advanceTimersByTime(GRACE - 1);
		const rebuilt = cache.acquire('c1/a', () => new Blob(['a']));
		vi.advanceTimersByTime(GRACE * 10);

		expect(rebuilt.url).toBe(old.url);
		expect(made).toHaveLength(1);
		expect(revoked).toEqual([]);
	});

	it('hands back a URL already made without a blob, holding it, and nothing for one not made', () => {
		const { urls, made, revoked } = factory();
		const cache = createObjectUrlCache(urls, GRACE);

		expect(cache.reuse('c1/a')).toBeUndefined();
		const old = cache.acquire('c1/a', () => new Blob(['a']));
		old.release();
		vi.advanceTimersByTime(GRACE - 1);
		const rebuilt = cache.reuse('c1/a');
		vi.advanceTimersByTime(GRACE * 10);

		expect(rebuilt?.url).toBe(old.url);
		expect(made).toHaveLength(1);
		expect(revoked).toEqual([]);
		rebuilt?.release();
		vi.advanceTimersByTime(GRACE);
		expect(revoked).toEqual([old.url]);
		expect(cache.reuse('c1/a')).toBeUndefined();
	});

	it('counts a release once, however often it is called', () => {
		const { urls, revoked } = factory();
		const cache = createObjectUrlCache(urls, GRACE);
		const first = cache.acquire('c1/a', () => new Blob(['a']));
		const second = cache.acquire('c1/a', () => new Blob(['a']));

		first.release();
		first.release();
		vi.advanceTimersByTime(GRACE);

		expect(revoked).toEqual([]);
		second.release();
		vi.advanceTimersByTime(GRACE);
		expect(revoked).toEqual([first.url]);
	});

	it('makes a new URL for a key asked for after its old one was revoked', () => {
		const { urls, made } = factory();
		const cache = createObjectUrlCache(urls, GRACE);
		const old = cache.acquire('c1/a', () => new Blob(['a']));
		old.release();
		vi.advanceTimersByTime(GRACE);

		const again = cache.acquire('c1/a', () => new Blob(['a']));

		expect(again.url).not.toBe(old.url);
		expect(made).toHaveLength(2);
	});
});
