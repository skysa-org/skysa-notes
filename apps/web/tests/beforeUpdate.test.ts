import { describe, expect, it, vi } from 'vitest';

import {
	browserUpdateChannel,
	MAKE_WAY_MS,
	makeWay,
	makeWayWhenAsked,
	type UpdateChannel,
	updateChannel,
} from '../src/sync/beforeUpdate.js';

/**
 * Stopping the app's requests before a new build is asked to take over: in
 * Chromium a request started while it waits holds the take-over for five
 * minutes (`src/sync/beforeUpdate.ts`).
 */

const recordingChannel = (calls: string[]) => {
	const handlers = new Set<() => void>();
	const channel: UpdateChannel = {
		announce: () => {
			calls.push('announce');
		},
		onAnnounce: (handler) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close: () => undefined,
	};
	return { channel, hear: () => [...handlers].forEach((handler) => handler()) };
};

describe('making way for a new build', () => {
	it('tells the other tabs, pauses this one, and gives them a moment before it resolves', async () => {
		const calls: string[] = [];
		const { channel } = recordingChannel(calls);
		const waited = Promise.withResolvers<undefined>();
		const settled = vi.fn();

		const making = makeWay(
			{
				pause: () => {
					calls.push('pause');
				},
			},
			channel,
			(ms) => {
				calls.push(`wait ${String(ms)}`);
				return waited.promise;
			}
		).then(settled);

		expect(calls).toEqual(['announce', 'pause', `wait ${String(MAKE_WAY_MS)}`]);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();

		waited.resolve(undefined);
		await making;
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it('pauses this tab when another announces, until it stops listening', () => {
		const { channel, hear } = recordingChannel([]);
		const pause = vi.fn();

		const stop = makeWayWhenAsked({ pause }, channel);
		hear();
		expect(pause).toHaveBeenCalledTimes(1);

		stop();
		hear();
		expect(pause).toHaveBeenCalledTimes(1);
	});

	it('reaches every other tab over the browser channel, and not the one that announced', async () => {
		const here = browserUpdateChannel();
		const there = browserUpdateChannel();
		const heardHere = vi.fn();
		const heard = Promise.withResolvers<undefined>();
		here.onAnnounce(heardHere);
		there.onAnnounce(() => {
			heard.resolve(undefined);
		});

		here.announce();
		await heard.promise;
		// One more turn for a message to itself to have arrived, were it sent.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(heardHere).not.toHaveBeenCalled();

		here.close();
		there.close();
	});

	it("keeps one channel to a tab, so the tab's own announcement never pauses it twice", () => {
		const first = updateChannel();
		expect(updateChannel()).toBe(first);
		first.close();
	});
});
