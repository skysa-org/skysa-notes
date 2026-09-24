import { type NotesDatabase } from './db.js';

/**
 * Asking the browser to keep this device's notes.
 *
 * A browser treats an origin's storage as a cache until the origin asks
 * otherwise: Chromium and Firefox may clear IndexedDB, all of it at once, when
 * the disk runs short, and Safari deletes every kind of storage a script can
 * write after seven days of Safari use with no interaction with the site. For
 * a library with no storage connected, that store is the only copy there is,
 * and nothing inside the origin can tell afterwards that it was cleared: the
 * next open looks like a new install (docs/ARCHITECTURE.md §8, "Keeping the
 * store").
 *
 * `navigator.storage.persist()` is the request. Firefox answers it with a
 * permission prompt, so it is only ever made in answer to something the user
 * did, and never on load; Chromium and Safari decide without asking, from how
 * the site has been used and whether it is installed.
 * https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
 * https://web.dev/articles/persistent-storage
 * https://webkit.org/blog/14403/updates-to-storage-policy/
 */

/** The two calls this module makes of `navigator.storage`. */
export interface StorageKeeper {
	/** Whether the browser has already agreed. Never prompts. */
	readonly persisted: () => Promise<boolean>;
	/** Ask it to. May prompt (Firefox). */
	readonly persist: () => Promise<boolean>;
}

/**
 * The browser's own, or nothing where it has none — an old browser, a page
 * that is not a secure context, and jsdom, which is why every caller is handed
 * this rather than reaching for `navigator` itself. None counts as not kept.
 *
 * Wrapped rather than handed over: the interface's property signatures let a
 * caller take `persist` off it and call it alone, which on the real
 * `StorageManager` throws "Illegal invocation" and on a test's plain object
 * works, so no test would ever say so.
 */
export const browserKeeper = (): StorageKeeper | undefined => {
	const storage = (globalThis.navigator as Navigator | undefined)?.storage as
		Partial<StorageManager> | undefined;
	if (typeof storage?.persist !== 'function' || typeof storage.persisted !== 'function') {
		return undefined;
	}
	const manager = storage as StorageManager;
	return { persisted: () => manager.persisted(), persist: () => manager.persist() };
};

/**
 * What the browser has said: nothing yet, that it will keep the store, or that
 * it may clear it. A browser that cannot say is the last.
 */
export type Kept = 'unknown' | 'kept' | 'not-kept';

/**
 * Why the request is being made.
 *
 * `first-note` is the first note written in the device's own library: the
 * first thing here that exists nowhere else. It asks once per device, and the
 * answer stands: after a "no", a prompt on every note would be asking the user
 * to change their mind by wearing them down. `installed` is the app being
 * installed, which is one of the things Chromium's heuristic weighs, so a "no"
 * from before is asked again: the answer it was is no longer the answer it
 * would be. It does not spend the `first-note` request.
 */
export type Occasion = 'first-note' | 'installed';

/** Set once the `first-note` request has been made on this device. */
export const KEEP_ASKED_KEY = 'storage.keepAsked';

export interface Keeping {
	readonly state: () => Kept;
	readonly subscribe: (listener: () => void) => () => void;
	/** Find out what the browser has decided, without asking it anything. */
	readonly check: () => Promise<void>;
	/**
	 * Ask it to keep the store, unless it already does or, for a first note, has
	 * been asked before. Never rejects: a failure counts as not kept.
	 */
	readonly ask: (db: Pick<NotesDatabase, 'prefs'>, occasion: Occasion) => Promise<void>;
}

/**
 * One answer for the whole tab. The request is made where a note is created
 * and the answer is shown in the storage panel, which are two components that
 * know nothing of each other, so the answer is held here and both read it.
 *
 * `keeper` is asked on every call rather than once, so a test can stand in for
 * `navigator.storage` after the module has loaded.
 */
export const createKeeping = (keeper: () => StorageKeeper | undefined): Keeping => {
	const box = new Map<'state', Kept>([['state', 'unknown']]);
	const listeners = new Set<() => void>();

	const set = (next: Kept) => {
		if (box.get('state') === next) return;
		box.set('state', next);
		listeners.forEach((listener) => {
			listener();
		});
	};

	/** What the browser says now, or nothing kept where it cannot say. */
	const decided = async (storage: StorageKeeper | undefined): Promise<boolean> =>
		storage === undefined ? false : storage.persisted().catch(() => false);

	/** Whether the store is kept, having asked where it may be asked. */
	const request = async (
		db: Pick<NotesDatabase, 'prefs'>,
		occasion: Occasion
	): Promise<boolean> => {
		const storage = keeper();
		if (await decided(storage)) return true;
		if (storage === undefined) return false;
		if (occasion === 'first-note') {
			if ((await db.prefs.get(KEEP_ASKED_KEY)) !== undefined) return false;
			// Written down before the request: a prompt the user closes without
			// answering leaves the promise waiting, and this must still read as
			// asked on the next note.
			await db.prefs.put({ key: KEEP_ASKED_KEY, value: new Date().toISOString() });
		}
		return storage.persist();
	};

	return {
		state: () => box.get('state') ?? 'unknown',
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		check: async () => {
			set((await decided(keeper())) ? 'kept' : 'not-kept');
		},
		// Nothing here throws to the caller, which makes the request after a note
		// is created and does not wait for it. The store failing to read or write
		// the pref — a full disk, the case this is all about — is an answer too.
		ask: async (db, occasion) => {
			set((await request(db, occasion).catch(() => false)) ? 'kept' : 'not-kept');
		},
	};
};

/** The tab's own, over `navigator.storage`. */
export const keeping = createKeeping(browserKeeper);
