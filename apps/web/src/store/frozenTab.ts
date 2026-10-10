import type Dexie from 'dexie';

import { tabState } from './staleTab.js';

/**
 * What to do when the browser freezes this tab.
 *
 * Chrome freezes a tab that has been hidden for a while, a minute on Android:
 * its timers stop, and so do the answers to its IndexedDB requests, until it is
 * shown again. A BroadcastChannel message still reaches it, though, and its
 * handler runs (Chrome 155, Android and desktop, 2026-10-10). That is how
 * Dexie tells the other tabs of a write, and its handler re-runs every live
 * query there. So a frozen tab goes on asking for reads each time another tab
 * writes, and cannot take the answers. A read never answered is a transaction
 * never finished, and it holds its tables until the tab is shown again: the
 * next write any other tab makes to them waits behind it, and every read there
 * waits behind that write. Reported on a phone: with the app frozen in a
 * browser tab, the installed app showed its notebooks but could not open a
 * note, and said "Syncing…" for as long as the tab was left open.
 *
 * So the tab lets go of the database as it is frozen, which is Chrome's own
 * advice for `freeze` (https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
 * Auto-open is left on. A live query re-run while frozen then asks for the
 * database to be opened, which holds no table; the open's answer waits with
 * everything else, and the query runs once the tab is resumed, through the
 * same check against a newer build as every other open (`store/staleTab.ts`).
 *
 * What it cannot help is a transaction already under way as the freeze comes:
 * IndexedDB closes a connection only once its transactions are done. Chrome
 * holds off freezing a tab while one of its transactions blocks another tab's,
 * so that is left to it.
 *
 * A frozen tab no longer holds up a newer build's upgrade, then, and resumes
 * as a tab that was not open for it. Where the newer schema has dropped
 * something this build declares, Dexie puts it back as it reopens, before the
 * check can stop it (docs/ARCHITECTURE.md §7, "A newer build in another tab
 * ends this one").
 */
export const letGoWhenFrozen = (db: Dexie): void => {
	// Open as far as Dexie is concerned: from the open's `ready` to the next
	// close. `isOpen()` says so earlier, as soon as the connection is there and
	// while an upgrade is still running in it; closed then, the open finishes
	// with no connection, and every read and write after it fails without one
	// being asked for again.
	const open = { current: false };
	db.on(
		'ready',
		() => {
			open.current = db.isOpen();
		},
		true
	);
	db.on('close', () => {
		open.current = false;
	});
	document.addEventListener('freeze', () => {
		// Out of date is closed for good, and a close that leaves auto-open on
		// would open it again. One still opening is left to finish.
		if (tabState() === 'stale' || !open.current) return;
		db.close({ disableAutoOpen: false });
	});
};
