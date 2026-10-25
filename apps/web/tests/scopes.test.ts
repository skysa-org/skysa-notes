import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { libraryTables, sourceTables, writerTables } from '../src/store/scopes.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const fresh = async (): Promise<NotesDatabase> => {
	const db = createDatabase(`scopes-${crypto.randomUUID()}`);
	opened.push(db);
	await db.open();
	return db;
};

const names = (tables: readonly { name: string }[]): string[] =>
	tables.map((table) => table.name).sort();

describe('the scopes transactions share', () => {
	it('lets go of a source with every table that holds its rows', async () => {
		// A table keyed or indexed by connection that a source is not moved,
		// detached or let go with would keep rows of a source this device no
		// longer has. A table added later has to be added to `sourceTables`.
		const db = await fresh();
		const bySource = db.tables
			.filter(({ schema }) =>
				[schema.primKey, ...schema.indexes].some((index) =>
					[index.keyPath].flat().includes('connectionId')
				)
			)
			.map((table) => table.name);
		const scope = names(sourceTables(db));

		expect(bySource.filter((name) => !scope.includes(name))).toEqual([]);
		// And the two kept by connection under another name: a source's
		// credential, keyed by its id, and its prefs, keyed `<name>:<id>`.
		expect(scope).toEqual(expect.arrayContaining(['credentials', 'prefs']));
	});

	it('widens each scope from the one before it', async () => {
		const db = await fresh();

		expect(names(libraryTables(db))).toEqual(expect.arrayContaining(names(writerTables(db))));
		expect(names(sourceTables(db))).toEqual(expect.arrayContaining(names(libraryTables(db))));
	});
});
