import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api/client.js';
import { failedAt, saying } from '../src/errors/reached.js';

/**
 * The seam the panel's wordings hang off. Its three properties are each a wrong
 * message if they break, and two of them are reachable only from a caller the
 * app does not have today — a client seam that throws where it stands, and a
 * throw in the handler of a call that already landed — so they are pinned here
 * rather than through the panel.
 */

const WORDS = {
	answered: 'answered',
	unreachable: 'unreachable',
	device: 'device',
	unknown: 'unknown',
} as const;

const caught = async (work: Promise<unknown>): Promise<unknown> =>
	work.then(
		() => undefined,
		(error: unknown) => error
	);

describe('how far a failure got', () => {
	it('keeps the innermost label, so work inside other work is still its own', async () => {
		const inner = () => failedAt('server', () => Promise.reject(new TypeError('offline')));
		const error = await caught(failedAt('device', inner));

		expect(saying(error, WORDS)).toBe('unreachable');
	});

	it('labels a call that throws where it stands, not only one that rejects', async () => {
		const error = await caught(
			failedAt('device', () =>
				failedAt('server', () => {
					throw new TypeError('the seam refused');
				})
			)
		);

		// Handed the promise instead of the call, the throw would happen before
		// `failedAt` saw anything and the outer label would claim it.
		expect(saying(error, WORDS)).toBe('unreachable');
	});

	it('tells a server that answered from one that never did', async () => {
		const answered = await caught(
			failedAt('server', () => Promise.reject(new ApiError('failed with 500', 500)))
		);
		const silent = await caught(
			failedAt('server', () => Promise.reject(new TypeError('offline')))
		);

		expect(saying(answered, WORDS)).toBe('answered');
		expect(saying(silent, WORDS)).toBe('unreachable');
	});

	it('says nothing about an error from neither call', async () => {
		const stray = await caught(
			failedAt('device', () => Promise.resolve()).then(() => {
				throw new Error('in the handler, after the work landed');
			})
		);

		expect(saying(stray, WORDS)).toBe('unknown');
		expect(saying(undefined, WORDS)).toBe('unknown');
	});

	it('keeps the cause and its message, for anything that reads one', async () => {
		const cause = new TypeError('offline');
		const error = await caught(failedAt('device', () => Promise.reject(cause)));

		expect((error as Error).message).toBe('offline');
		expect((error as Error).cause).toBe(cause);
	});
});
