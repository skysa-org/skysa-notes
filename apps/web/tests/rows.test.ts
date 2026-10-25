import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { rowsOf } from '../src/store/rows.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

describe('rowsOf', () => {
	it("is one source's rows, and none of another's", async () => {
		const db = createDatabase(`rows-${crypto.randomUUID()}`);
		opened.push(db);
		await db.folders.bulkPut([
			{ connectionId: 'c1', path: 'a', createdAt: 0 },
			{ connectionId: 'c1', path: 'b', createdAt: 0 },
			{ connectionId: 'c10', path: 'a', createdAt: 0 },
		]);

		const paths = (await rowsOf(db.folders, 'c1').toArray()).map((row) => row.path);

		expect(paths.sort()).toEqual(['a', 'b']);
		expect(await rowsOf(db.folders, 'c2').count()).toBe(0);
	});
});
