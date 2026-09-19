import type Dexie from 'dexie';

import { flushEditors } from './heldEdits.js';

/**
 * What to do when a newer build, in another tab, asks for the database.
 *
 * IndexedDB sends every open connection a `versionchange` and holds the upgrade
 * until they have all closed. Dexie's own answer is to close and leave auto-open
 * on, so this tab's next read or write opens the database again — and Dexie 4
 * does not fail that open against a newer database: it retries with no version
 * and carries on, old code against a schema it has never seen. Where the newer
 * schema lacks something this build declares, it goes further and upgrades the
 * database again to put it back, underneath the tab that had just migrated it.
 * Nothing on screen says any of it has happened.
 *
 * So this tab stops instead. It says it is out of date, lets what is part-way
 * to the store get there — the upgrade is waiting on this connection, so there
 * is time, and it is bounded — and closes for good. Every later operation
 * rejects with `DatabaseClosed` rather than reopening.
 */

/**
 * `waiting` is the other side: this tab asked for an upgrade and an older one
 * has not let go yet, so every read here hangs until it does.
 */
export type TabState = 'current' | 'waiting' | 'stale';

/** How long the upgrade is kept waiting for writes that are under way. */
export const CLOSE_GRACE_MS = 2000;

/**
 * How long an upgrade is blocked before it is worth saying. An older tab that
 * is finishing a write lets go within moments, and a notice that flashed up for
 * that would be noise.
 */
export const WAITING_NOTICE_MS = 1000;

const tab: { current: TabState } = { current: 'current' };
const listeners = new Set<() => void>();

const publish = (next: TabState) => {
	// Out of date is for good: the connection is closed and will not reopen.
	if (tab.current === next || tab.current === 'stale') return;
	tab.current = next;
	listeners.forEach((listener) => {
		listener();
	});
};

export const tabState = (): TabState => tab.current;

export const subscribeTabState = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/**
 * `wait` is for the event: the upgrade has not happened yet, and is held up
 * until this tab closes, so what an editor holds can still go into the schema
 * it was written for. Found out on opening, the newer schema is already live,
 * and anything written now is old code writing into it — so nothing is.
 */
const retire = (db: Dexie, wait: boolean) => {
	publish('stale');
	// What the editors hold (`beforeClosing` in `store/heldEdits.ts`), started
	// now. How it went is not asked: the tab is closing either way, and the
	// gate says what to do about text that did not make it.
	const work = wait ? flushEditors() : [];
	// With nothing to wait for, close before the event returns: the upgrade is
	// then never reported as blocked at all.
	if (work.length === 0) {
		db.close();
		return;
	}
	const grace = new Promise<void>((resolve) => {
		setTimeout(resolve, CLOSE_GRACE_MS);
	});
	// A transaction already running is finished by IndexedDB itself, which
	// closes a connection only once its transactions are done. The wait is for
	// writes that are several transactions, or have not opened theirs yet.
	void Promise.race([Promise.all(work), grace]).then(() => {
		db.close();
	});
};

/**
 * Is the database on disk a later build's? Dexie numbers the native database
 * ten to a version, and takes one of the ten for itself when it patches a
 * schema, so only a whole version more is somebody else's.
 */
const upgradedElsewhere = (db: Dexie): boolean =>
	// Typed as always there; it is null on a database that is not open.
	((db.backendDB() as IDBDatabase | null)?.version ?? 0) >= (db.verno + 1) * 10;

export const watchForNewerTab = (db: Dexie): void => {
	db.on('versionchange', (event) => {
		// A delete — "clear site data", devtools — is not a newer build, and says
		// so by having no new version. Dexie's own handler is left to it: closed,
		// and opened again, empty, when next asked.
		if (event.newVersion === null) return undefined;
		retire(db, true);
		// Stops the chain before Dexie's own handler, which closes with auto-open
		// left on.
		return false;
	});

	const notice: { current: ReturnType<typeof setTimeout> | null } = { current: null };
	db.on('blocked', () => {
		notice.current ??= setTimeout(() => {
			publish('waiting');
		}, WAITING_NOTICE_MS);
	});
	db.on(
		'ready',
		() => {
			if (notice.current !== null) clearTimeout(notice.current);
			notice.current = null;
			// The event above reaches a tab that is open when the upgrade is made.
			// One that was not — in the back-forward cache, its connection dropped
			// by the browser, or simply an old build loaded from a stale cache —
			// hears nothing, and Dexie opens it against the newer database without
			// an error (it retries a `VersionError` with no version at all). Every
			// route back in comes through here, so here is where it is asked.
			if (upgradedElsewhere(db)) {
				retire(db, false);
				return;
			}
			publish('current');
		},
		true
	);
};
