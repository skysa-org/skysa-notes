import { describe, expect, it, vi } from 'vitest';

import { NotFoundError, RateLimitError } from '../../src/providers/types.js';
import { orIfNotFound, withParent } from '../../src/sync/providerOps.js';

describe('orIfNotFound', () => {
	it('answers what the provider did', async () => {
		await expect(orIfNotFound(Promise.resolve(['a']), [])).resolves.toEqual(['a']);
	});

	it('answers the fallback where there is nothing there', async () => {
		await expect(orIfNotFound(Promise.reject(new NotFoundError('a.md')), [])).resolves.toEqual(
			[]
		);
	});

	it('throws any other failure as it was', async () => {
		const limited = new RateLimitError('slow down');
		await expect(orIfNotFound(Promise.reject(limited), [])).rejects.toBe(limited);
	});
});

describe('withParent', () => {
	it('makes nothing when the first try lands', async () => {
		const makeParent = vi.fn(() => Promise.resolve());
		await expect(withParent(() => Promise.resolve('made'), makeParent)).resolves.toBe('made');
		expect(makeParent).not.toHaveBeenCalled();
	});

	it('makes the folder above and tries once more, where there was none', async () => {
		const act = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new NotFoundError('Work'))
			.mockResolvedValueOnce('made');
		const makeParent = vi.fn(() => Promise.resolve());
		await expect(withParent(act, makeParent)).resolves.toBe('made');
		expect(makeParent).toHaveBeenCalledTimes(1);
		expect(act).toHaveBeenCalledTimes(2);
	});

	it('throws a second not-found, and any other failure without making anything', async () => {
		const missing = new NotFoundError('Work');
		const makeParent = vi.fn(() => Promise.resolve());
		await expect(withParent(() => Promise.reject(missing), makeParent)).rejects.toBe(missing);
		expect(makeParent).toHaveBeenCalledTimes(1);

		const limited = new RateLimitError('slow down');
		const untouched = vi.fn(() => Promise.resolve());
		await expect(withParent(() => Promise.reject(limited), untouched)).rejects.toBe(limited);
		expect(untouched).not.toHaveBeenCalled();
	});
});
