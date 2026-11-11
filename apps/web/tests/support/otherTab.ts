import { cleanups } from '@skysa/client/testing';

import type { NotesDatabase } from '../../src/store/db.js';

/** Another tab's connection to the same database, as IndexedDB opens one. */
export const otherTab = (db: NotesDatabase) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(db.name);
		request.onsuccess = () => {
			resolve(request.result);
		};
		request.onerror = () => {
			reject(request.error ?? new Error('open failed'));
		};
	});

/**
 * Its transaction on `tables`, going until it is let go. Started at once, and
 * let go after the test whatever happens.
 */
export const holding = (other: IDBDatabase, tables: string[], mode: IDBTransactionMode) => {
	const store = other.transaction(tables, mode).objectStore(tables[0] ?? 'prefs');
	const held = { going: true };
	const again = () => {
		if (held.going) store.count().onsuccess = again;
	};
	again();
	const release = () => {
		held.going = false;
		other.close();
	};
	cleanups.unshift(release);
	return release;
};
