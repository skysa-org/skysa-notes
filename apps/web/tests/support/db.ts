import type Dexie from 'dexie';
import { onTestFinished } from 'vitest';

import { createDatabase, db, type NotesDatabase, watchTab } from '../../src/store/db.js';
import { deletedHere } from '../../src/store/deletedHere.js';
import { goneSources } from '../../src/store/goneSources.js';
import { movedRows } from '../../src/store/movedRows.js';

/**
 * How a test gets a database, and how it gets rid of it. Both are wired into
 * `tests/setup.ts`, so no test file clears tables or deletes databases itself.
 *
 * Two kinds of test, two kinds of database:
 * - a test of something that reads the app's own database, `db` from
 *   `src/store/db.ts` (a route, a hook, a component that does not take one),
 *   uses that, and it is emptied after every test: every table, not the ones
 *   the file thought to list. Twenty different hand-kept lists of tables let
 *   pins and preferences leak from one test into the next.
 * - a test that can hand a database in asks `freshDatabase` for one of its own,
 *   deleted after the test.
 */

const opened: Dexie[] = [];

/** A database of the test's own, under a name nobody else has. Deleted after the test. */
export const freshDatabase = (): NotesDatabase => {
	const made = createDatabase(`test-${crypto.randomUUID()}`);
	opened.push(made);
	return made;
};

/**
 * A database of the test's own, watched as the app's own is (`watchTab`): for
 * a newer tab, another tab holding it up, and the page being frozen. The
 * watchers stop when the test finishes, and the database is deleted.
 */
export const watchedDatabase = (): NotesDatabase => {
	const made = freshDatabase();
	onTestFinished(watchTab(made));
	return made;
};

/**
 * Another connection a test opened itself — a second tab on the same name, a
 * newer build's upgrade — deleted with the test's databases.
 */
export const deleteAfterTest = (database: Dexie): void => {
	opened.push(database);
};

export const deleteFreshDatabases = async (): Promise<void> => {
	await Promise.all(opened.splice(0).map((each) => each.delete()));
};

/**
 * The app's database emptied, every table, and the per-tab memory that is
 * keyed by its rows forgotten: what a fresh page load would find. One test
 * file is one page life, so without this a note deleted, moved or disconnected
 * in one test is remembered by the next. A database nothing has opened yet has
 * nothing in it, so it is left unopened.
 */
export const resetSharedDb = async (): Promise<void> => {
	deletedHere.clear();
	goneSources.clear();
	movedRows.clear();
	if (!db.isOpen()) return;
	await Promise.all(db.tables.map((table) => table.clear()));
};
