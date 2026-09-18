import type Dexie from 'dexie';

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
const unfinished = new Set<() => Promise<unknown>>();

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
 * Register work to be finished before the connection closes for good — an
 * editor's held edits. It should resolve whether or not the work succeeded.
 */
export const beforeClosing = (finish: () => Promise<unknown>): (() => void) => {
	unfinished.add(finish);
	return () => {
		unfinished.delete(finish);
	};
};

const retire = (db: Dexie) => {
	publish('stale');
	const work = [...unfinished].map((finish) =>
		// Inside the executor, so a `finish` that throws is one that settled.
		new Promise((resolve) => {
			resolve(finish());
		}).catch(() => undefined)
	);
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

export const watchForNewerTab = (db: Dexie): void => {
	db.on('versionchange', () => {
		retire(db);
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
			publish('current');
		},
		true
	);
};
