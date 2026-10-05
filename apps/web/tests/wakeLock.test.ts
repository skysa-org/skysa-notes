import { afterEach, describe, expect, it } from 'vitest';

import { type SchedulerStatus } from '../src/sync/scheduler.js';
import {
	keepAwakeWhileSyncing,
	type ScreenLock,
	type WakeLockEnvironment,
} from '../src/sync/wakeLock.js';

/**
 * The screen kept on through a long sync (`sync/wakeLock.ts`): a phone whose
 * screen times out mid-import takes the network with it.
 */

const LONG: SchedulerStatus = {
	phase: 'syncing',
	conflicts: [],
	progress: { stage: 'receiving', done: 3, total: 200 },
};
const IDLE: SchedulerStatus = { phase: 'idle', conflicts: [] };

const fakeScheduler = () => {
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const box = new Map<'status', SchedulerStatus>([['status', IDLE]]);
	return {
		status: () => box.get('status') ?? IDLE,
		subscribe: (listener: (status: SchedulerStatus) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publish: (status: SchedulerStatus) => {
			box.set('status', status);
			listeners.forEach((listener) => {
				listener(status);
			});
		},
	};
};

interface FakeLock {
	released: boolean;
	readonly lock: ScreenLock;
	/** As the browser does when the page is hidden. */
	readonly drop: () => void;
}

const fakeLock = (): FakeLock => {
	const handlers: (() => void)[] = [];
	const state: FakeLock = {
		released: false,
		lock: {
			release: () => {
				state.drop();
				return Promise.resolve();
			},
			onRelease: (handler) => {
				handlers.push(handler);
			},
		},
		drop: () => {
			if (state.released) return;
			state.released = true;
			handlers.forEach((handler) => {
				handler();
			});
		},
	};
	return state;
};

/**
 * A browser that grants, refuses, or answers when told to (`later`). Hiding
 * the page lets go of every lock, as a browser does.
 */
const fakeBrowser = (answer: 'grant' | 'refuse' | 'later' = 'grant') => {
	const visibility = new Set<() => void>();
	const locks: FakeLock[] = [];
	const waiting: (() => void)[] = [];
	const state = { visible: true, requests: 0 };
	const environment: WakeLockEnvironment = {
		isVisible: () => state.visible,
		onVisibilityChange: (handler) => {
			visibility.add(handler);
			return () => {
				visibility.delete(handler);
			};
		},
		request: () => {
			state.requests += 1;
			if (answer === 'refuse') {
				return Promise.reject(new DOMException('battery saver', 'NotAllowedError'));
			}
			const made = fakeLock();
			locks.push(made);
			if (answer === 'grant') return Promise.resolve(made.lock);
			return new Promise<void>((resolve) => {
				waiting.push(resolve);
			}).then(() => made.lock);
		},
	};
	const shown = (visible: boolean) => {
		state.visible = visible;
		if (!visible) {
			locks.forEach((made) => {
				made.drop();
			});
		}
		visibility.forEach((handler) => {
			handler();
		});
	};
	return {
		environment,
		requests: () => state.requests,
		held: () => locks.filter((made) => !made.released).length,
		hide: () => {
			shown(false);
		},
		show: () => {
			shown(true);
		},
		grant: () => {
			waiting.splice(0).forEach((resolve) => {
				resolve();
			});
		},
	};
};

/** Long enough for a request's answer, and what it sets off, to land. */
const settled = () =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

const stops: (() => void)[] = [];

const following = (
	scheduler: ReturnType<typeof fakeScheduler>,
	environment: WakeLockEnvironment
) => {
	const stop = keepAwakeWhileSyncing(scheduler, environment);
	stops.push(stop);
	return stop;
};

afterEach(() => {
	stops.splice(0).forEach((stop) => {
		stop();
	});
});

describe('keeping the screen on while syncing', () => {
	it('keeps it on through a long run, and lets go when the run ends', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser();
		following(scheduler, browser.environment);

		scheduler.publish(LONG);
		await settled();
		expect(browser.held()).toBe(1);

		// Progress arrives several times a second: one lock for the run.
		scheduler.publish({ ...LONG, progress: { stage: 'receiving', done: 4, total: 200 } });
		await settled();
		expect(browser.requests()).toBe(1);

		scheduler.publish(IDLE);
		await settled();
		expect(browser.held()).toBe(0);
	});

	it('leaves it alone for a run too short to count', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser();
		following(scheduler, browser.environment);

		scheduler.publish({
			phase: 'syncing',
			conflicts: [],
			progress: { stage: 'uploading', done: 0, total: 3 },
		});
		scheduler.publish({
			phase: 'syncing',
			conflicts: [],
			progress: { stage: 'scanning', found: 5, done: 0, listing: true },
		});
		scheduler.publish({ phase: 'syncing', conflicts: [] });
		await settled();
		expect(browser.requests()).toBe(0);

		// A scan still listing counts by what it has found so far.
		scheduler.publish({
			phase: 'syncing',
			conflicts: [],
			progress: { stage: 'scanning', found: 40, done: 0, listing: true },
		});
		await settled();
		expect(browser.held()).toBe(1);
	});

	it('lets go when the run fails, and asks again for the next', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser();
		following(scheduler, browser.environment);

		scheduler.publish(LONG);
		await settled();
		scheduler.publish({ phase: 'retrying', conflicts: [], error: 'Failed to fetch' });
		await settled();
		expect(browser.held()).toBe(0);

		scheduler.publish(LONG);
		await settled();
		expect(browser.requests()).toBe(2);
		expect(browser.held()).toBe(1);
	});

	it('asks again when the page is shown, the browser having let go as it was hidden', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser();
		following(scheduler, browser.environment);
		scheduler.publish(LONG);
		await settled();

		browser.hide();
		scheduler.publish(LONG);
		await settled();
		expect(browser.held()).toBe(0);
		expect(browser.requests()).toBe(1);

		browser.show();
		await settled();
		expect(browser.requests()).toBe(2);
		expect(browser.held()).toBe(1);
	});

	it('lets go of a lock the browser granted after the run ended', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser('later');
		following(scheduler, browser.environment);

		scheduler.publish(LONG);
		await settled();
		scheduler.publish(IDLE);
		browser.grant();
		await settled();

		expect(browser.requests()).toBe(1);
		expect(browser.held()).toBe(0);
	});

	it('asks once when refused, until the page is shown again', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser('refuse');
		following(scheduler, browser.environment);

		scheduler.publish(LONG);
		await settled();
		scheduler.publish(LONG);
		scheduler.publish(LONG);
		await settled();
		expect(browser.requests()).toBe(1);

		browser.hide();
		browser.show();
		await settled();
		expect(browser.requests()).toBe(2);
	});

	it('lets go when stopped, and asks for nothing after', async () => {
		const scheduler = fakeScheduler();
		const browser = fakeBrowser();
		const stop = following(scheduler, browser.environment);
		scheduler.publish(LONG);
		await settled();

		stop();
		scheduler.publish(LONG);
		await settled();

		expect(browser.held()).toBe(0);
		expect(browser.requests()).toBe(1);
	});

	it('does nothing where the browser has no wake lock', () => {
		const scheduler = fakeScheduler();
		const { environment } = fakeBrowser();
		following(scheduler, { ...environment, request: undefined });

		expect(() => {
			scheduler.publish(LONG);
		}).not.toThrow();
	});
});
