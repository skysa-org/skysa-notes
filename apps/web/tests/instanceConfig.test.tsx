import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { InstanceConfig } from '../src/api/client.js';
import { useInstanceConfig } from '../src/api/instanceConfig.js';

/**
 * `/api/config`, asked once per client however many components want it, and
 * answered only into the run that asked: not a component that has gone, and
 * not one that has since been handed another client.
 */

const DROPBOX: InstanceConfig = { authMode: 'storage-first', providers: ['dropbox'] };
const DRIVE: InstanceConfig = { authMode: 'storage-first', providers: ['gdrive'] };

/** A request the test settles when it chooses. */
const held = <T,>() => {
	const settle: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((resolve) => {
		settle.resolve = resolve;
	});
	return { promise, resolve: (value: T) => settle.resolve?.(value) };
};

describe('useInstanceConfig', () => {
	it('asks once for every component using one client', async () => {
		const client = { config: vi.fn(() => Promise.resolve(DROPBOX)) };
		const first = renderHook(() => useInstanceConfig(client));
		const second = renderHook(() => useInstanceConfig(client));

		await waitFor(() => {
			expect(first.result.current).toEqual({ kind: 'answered', value: DROPBOX });
			expect(second.result.current).toEqual({ kind: 'answered', value: DROPBOX });
		});
		expect(client.config).toHaveBeenCalledTimes(1);
	});

	it('asks again after a request that failed, which it does not remember', async () => {
		const client = {
			config: vi
				.fn<() => Promise<InstanceConfig>>()
				.mockRejectedValueOnce(new TypeError('offline'))
				.mockResolvedValue(DROPBOX),
		};
		const offline = renderHook(() => useInstanceConfig(client));
		await waitFor(() => {
			expect(offline.result.current).toEqual({ kind: 'unreachable' });
		});
		offline.unmount();

		const back = renderHook(() => useInstanceConfig(client));
		await waitFor(() => {
			expect(back.result.current).toEqual({ kind: 'answered', value: DROPBOX });
		});
		expect(client.config).toHaveBeenCalledTimes(2);
	});

	it('is not answered by the client it had before, however late that answers', async () => {
		const before = held<InstanceConfig>();
		const old = { config: () => before.promise };
		const now = { config: () => Promise.resolve(DRIVE) };
		const { result, rerender } = renderHook(({ client }) => useInstanceConfig(client), {
			initialProps: { client: old },
		});

		rerender({ client: now });
		await waitFor(() => {
			expect(result.current).toEqual({ kind: 'answered', value: DRIVE });
		});
		// In `act`, so whatever the old run's `then` sets is rendered before
		// the result is read.
		await act(async () => {
			before.resolve(DROPBOX);
			await before.promise;
		});
		expect(result.current).toEqual({ kind: 'answered', value: DRIVE });
	});
});
