import { cell } from '@skysa/core';

import { type SyncScheduler } from './scheduler.js';

/**
 * Making way for a new build, before `UpdatePrompt`'s Reload asks for it.
 *
 * Reload asks the waiting service worker to take over (`skipWaiting`), and the
 * page reloads once it has. Chromium lets it take over only once the worker it
 * replaces has no event in flight, and every request a page it controls makes
 * is a fetch event there: a sync's requests to the provider most of all. A
 * request that starts while the take-over waits holds it, and from then on a
 * quiet moment no longer lets it through. It waits out Chromium's five-minute
 * limit on an outgoing worker instead, through Reload pressed again and the
 * page reloaded by hand, with the prompt still up. Measured 2026-10-13 on
 * Chromium 153, two builds of this app and a page making four requests at a
 * time: asked while they went on, the take-over came 300 s later, not when
 * they stopped; asked once they had stopped, it came at once. A request
 * already out when it is asked does no harm; only one started after it does.
 * A sync goes on most of the time the app is open on a phone, where a Drive
 * round can take a while, so Reload seemed to do nothing.
 *
 * So the app stops making requests first. This tab's sync is paused, as the
 * user's pause would pause it (`pause` in `scheduler.ts`): the run's requests
 * are aborted and no other starts. Every other tab is asked to do the same,
 * since a sync another tab runs goes through the same worker; a tab hidden or
 * frozen still takes the message. After the reload syncing starts again by
 * itself, since a pause lasts only until the app is opened again.
 *
 * What it cannot stop is a request nothing here makes — a picture opened in
 * the moment, a tab of an older build that does not listen. Those hold the
 * take-over to the five minutes, as before, and `UpdatePrompt` says so.
 */

/** How long the other tabs are given to hear and pause before the ask. */
export const MAKE_WAY_MS = 250;

/** What this module needs of a `BroadcastChannel`, so a test can stand in. */
export interface UpdateChannel {
	/** Tells every other tab of this app; never this one. */
	readonly announce: () => void;
	/** Called when another tab announces. Returns the way to stop listening. */
	readonly onAnnounce: (handler: () => void) => () => void;
	readonly close: () => void;
}

const CHANNEL = 'skysa-update';

/** Every tab of the app on this origin. Silent where there is no BroadcastChannel. */
export const browserUpdateChannel = (): UpdateChannel => {
	if (typeof BroadcastChannel === 'undefined') {
		return {
			announce: () => undefined,
			onAnnounce: () => () => undefined,
			close: () => undefined,
		};
	}
	const channel = new BroadcastChannel(CHANNEL);
	return {
		announce: () => {
			channel.postMessage('make-way');
		},
		onAnnounce: (handler) => {
			const listener = (event: MessageEvent) => {
				if (event.data === 'make-way') handler();
			};
			channel.addEventListener('message', listener);
			return () => {
				channel.removeEventListener('message', listener);
			};
		},
		close: () => {
			channel.close();
		},
	};
};

const shared = cell<UpdateChannel | undefined>(undefined);

/**
 * This tab's one channel, made on first use: the tab that announces must not
 * hear itself, and a message reaches every channel of the name but the one
 * that sent it.
 */
export const updateChannel = (): UpdateChannel => {
	const made = shared.current ?? browserUpdateChannel();
	shared.current = made;
	return made;
};

/**
 * In every tab, from the start (`main.tsx`): pause syncing when another tab is
 * about to take a new build. Returns the way to stop listening.
 */
export const makeWayWhenAsked = (
	scheduler: Pick<SyncScheduler, 'pause'>,
	channel: UpdateChannel
): (() => void) =>
	channel.onAnnounce(() => {
		scheduler.pause();
	});

/**
 * In the tab whose Reload was pressed: pause here and in every other tab, then
 * give them `MAKE_WAY_MS` to do it. Resolves when the take-over can be asked.
 */
export const makeWay = async (
	scheduler: Pick<SyncScheduler, 'pause'>,
	channel: UpdateChannel,
	wait: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		})
): Promise<void> => {
	channel.announce();
	scheduler.pause();
	await wait(MAKE_WAY_MS);
};
