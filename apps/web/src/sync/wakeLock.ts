import { cell } from '@skysa/core';

import { isLongRun } from './progress.js';
import { type SchedulerStatus, type SyncScheduler } from './scheduler.js';

/**
 * The screen kept on while a long sync runs in front of the user. A phone
 * whose screen times out mid-import suspends the network with it, and the run
 * fails part-way; the engine keeps what it had read (`held` in
 * `packages/core/src/sync/engine.ts`), but the run is still stopped until the
 * phone is unlocked. Only for a run long enough to count (`isLongRun`) — an
 * edit sent is over before a screen could time out — and only while the page
 * is visible, which is the only time a browser grants one. It lets go when the
 * run ends or fails.
 *
 * The browser lets go of it as the page is hidden, so it is asked for again
 * when the page is shown if the run is still going. A browser without the API,
 * or one that refuses (Android's battery saver can), syncs as it did.
 * https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 *
 * Framework-free, and everything it reads from the browser comes through
 * `WakeLockEnvironment`, as the scheduler's does.
 */

/** A lock held: what this module needs of a `WakeLockSentinel`. */
export interface ScreenLock {
	readonly release: () => Promise<void>;
	/** Called once the lock is let go, by this module or by the browser. */
	readonly onRelease: (handler: () => void) => void;
}

export interface WakeLockEnvironment {
	readonly isVisible: () => boolean;
	/** Returns the way to stop listening. */
	readonly onVisibilityChange: (handler: () => void) => () => void;
	/** `undefined` where the browser has no wake lock. */
	readonly request: (() => Promise<ScreenLock>) | undefined;
}

const browserWakeLock = (): WakeLockEnvironment => ({
	isVisible: () => document.visibilityState === 'visible',
	onVisibilityChange: (handler) => {
		document.addEventListener('visibilitychange', handler);
		return () => {
			document.removeEventListener('visibilitychange', handler);
		};
	},
	request:
		'wakeLock' in navigator
			? async () => {
					const sentinel = await navigator.wakeLock.request('screen');
					return {
						release: () => sentinel.release(),
						onRelease: (handler) => {
							sentinel.addEventListener('release', handler, { once: true });
						},
					};
				}
			: undefined,
});

const wanted = (status: SchedulerStatus): boolean =>
	status.phase === 'syncing' && isLongRun(status.progress);

/** Starts following `scheduler`. Returns the way to stop, which lets go of any lock. */
export const keepAwakeWhileSyncing = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'>,
	environment: WakeLockEnvironment = browserWakeLock()
): (() => void) => {
	const { request } = environment;
	if (request === undefined) return () => undefined;

	const held = cell<ScreenLock | undefined>(undefined);
	/** A request not yet answered: one at a time. */
	const asking = cell(false);
	/**
	 * Refused, and not asked again until the page is shown again or another
	 * run starts: battery saver says no to every request, and progress
	 * arrives several times a second.
	 */
	const refused = cell(false);
	const stopped = cell(false);

	const release = () => {
		const lock = held.current;
		held.current = undefined;
		void lock?.release().catch(() => undefined);
	};

	const follow = () => {
		if (stopped.current || !wanted(scheduler.status())) {
			refused.current = false;
			release();
			return;
		}
		if (held.current !== undefined || asking.current || refused.current) return;
		if (!environment.isVisible()) return;
		asking.current = true;
		void request().then(
			(lock) => {
				asking.current = false;
				held.current = lock;
				lock.onRelease(() => {
					if (held.current === lock) held.current = undefined;
				});
				// The run may have ended, or the app stopped, while the browser
				// answered: this lets go of it again.
				follow();
			},
			() => {
				asking.current = false;
				refused.current = true;
			}
		);
	};

	const unsubscribe = scheduler.subscribe(follow);
	const unlisten = environment.onVisibilityChange(() => {
		refused.current = false;
		follow();
	});
	follow();

	return () => {
		stopped.current = true;
		unsubscribe();
		unlisten();
		release();
	};
};
