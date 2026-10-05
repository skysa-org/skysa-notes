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

export const browserWakeLock = (): WakeLockEnvironment => ({
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

	const held = new Map<'lock', ScreenLock>();
	/** A request not yet answered: one at a time. */
	const asking = new Set<'request'>();
	/**
	 * Refused, and not asked again until the page is shown again or another
	 * run starts: battery saver says no to every request, and progress
	 * arrives several times a second.
	 */
	const refused = new Set<'refused'>();
	const stopped = new Set<'stopped'>();

	const release = () => {
		const lock = held.get('lock');
		held.delete('lock');
		void lock?.release().catch(() => undefined);
	};

	const follow = () => {
		if (stopped.has('stopped') || !wanted(scheduler.status())) {
			refused.clear();
			release();
			return;
		}
		if (held.has('lock') || asking.has('request') || refused.has('refused')) return;
		if (!environment.isVisible()) return;
		asking.add('request');
		void request().then(
			(lock) => {
				asking.delete('request');
				held.set('lock', lock);
				lock.onRelease(() => {
					if (held.get('lock') === lock) held.delete('lock');
				});
				// The run may have ended, or the app stopped, while the browser
				// answered: this lets go of it again.
				follow();
			},
			() => {
				asking.delete('request');
				refused.add('refused');
			}
		);
	};

	const unsubscribe = scheduler.subscribe(follow);
	const unlisten = environment.onVisibilityChange(() => {
		refused.clear();
		follow();
	});
	follow();

	return () => {
		stopped.add('stopped');
		unsubscribe();
		unlisten();
		release();
	};
};
