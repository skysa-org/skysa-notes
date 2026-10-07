import { liveQuery, type Subscription } from 'dexie';

import type { NotesDatabase } from './db.js';
import { listFilePaths } from './files.js';

/**
 * Hearing that the files in a source have changed: one live query per source,
 * however many listen (#276).
 *
 * Each open note's host and each scratch card with a picture in it listens,
 * so that a picture that was missing is looked for again once a pull brings
 * its file (`useNoteAttachments`). Each used to run a query of its own over
 * every file row in the source, re-run on every write to the table: a wall of
 * fifty picture cards was fifty of them. Now the first to listen starts the
 * query, the rest share it, and the last to stop ends it.
 */

interface Watch {
	readonly listeners: Set<() => void>;
	readonly subscription: Subscription;
}

const watching = new WeakMap<NotesDatabase, Map<string, Watch>>();

const watchesOf = (db: NotesDatabase): Map<string, Watch> => {
	const known = watching.get(db);
	if (known !== undefined) return known;
	const made = new Map<string, Watch>();
	watching.set(db, made);
	return made;
};

const start = (db: NotesDatabase, connectionId: string, watches: Map<string, Watch>): Watch => {
	const listeners = new Set<() => void>();
	// The paths last heard, so a re-run that found the same files tells no one.
	const heard = new Map<'paths', string>();
	const subscription = liveQuery(async () =>
		(await listFilePaths(db, { connectionId })).join('\n')
	).subscribe({
		next: (paths) => {
			if (heard.get('paths') === paths) return;
			heard.set('paths', paths);
			listeners.forEach((listener) => {
				listener();
			});
		},
		// A store that cannot be read says nothing: the views ask again as
		// they would have anyway, on a sync or the network coming back.
		error: () => undefined,
	});
	const watch = { listeners, subscription };
	watches.set(connectionId, watch);
	return watch;
};

/**
 * Call `listener` whenever the paths of `connectionId`'s files change. The
 * first to listen hears the first read too; one joining later hears only
 * changes after it. Returns how to stop.
 */
export const watchSourceFiles = (
	db: NotesDatabase,
	connectionId: string,
	listener: () => void
): (() => void) => {
	const watches = watchesOf(db);
	const watch = watches.get(connectionId) ?? start(db, connectionId, watches);
	watch.listeners.add(listener);
	return () => {
		watch.listeners.delete(listener);
		if (watch.listeners.size > 0 || watches.get(connectionId) !== watch) return;
		watch.subscription.unsubscribe();
		watches.delete(connectionId);
	};
};
