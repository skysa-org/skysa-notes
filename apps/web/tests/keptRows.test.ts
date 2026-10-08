import { describe, expect, it } from 'vitest';

import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { keptRows } from '../src/store/keptRows.js';

const row = (id: string, changed: Partial<NoteRecord> = {}): NoteRecord => ({
	id,
	connectionId: LOCAL_CONNECTION_ID,
	path: `Work/${id}.md`,
	title: id,
	body: `${id}\n`,
	frontmatter: null,
	tags: ['a'],
	contentHash: 'h',
	dirty: 0,
	deletedLocally: 0,
	createdAt: 1,
	updatedAt: 1,
	...changed,
});

const byId = (rows: readonly NoteRecord[]) => new Map(rows.map((each) => [each.id, each]));

describe('keptRows', () => {
	it('hands back the object read before for a note that has not changed', () => {
		const before = [row('plan'), row('retro')];
		const read = keptRows(byId(before), [row('plan'), row('retro')]);
		expect(read[0]).toBe(before[0]);
		expect(read[1]).toBe(before[1]);
	});

	it('hands back the new read for a note any field of which changed', () => {
		const before = row('plan');
		const changes: Partial<NoteRecord>[] = [
			{ body: 'plan, edited\n' },
			{ updatedAt: 2 },
			{ dirty: 1 },
			{ tags: ['a', 'b'] },
			{ tags: ['b'] },
			{ remoteId: 'r1' },
			{ connectionId: 'dropbox-1' },
		];
		changes.forEach((change) => {
			const [read] = keptRows(byId([before]), [row('plan', change)]);
			expect(read).not.toBe(before);
			expect(read).toEqual(row('plan', change));
		});
	});

	it('hands back the new read for a note that has lost a field', () => {
		const before = row('plan', { remoteId: 'r1' });
		const [read] = keptRows(byId([before]), [row('plan')]);
		expect(read).not.toBe(before);
	});

	it('hands back the new read for a note that has as many fields, but other ones', () => {
		const before = row('plan', { remoteId: undefined });
		const [read] = keptRows(byId([before]), [row('plan', { remoteVersion: 'v1' })]);
		expect(read).not.toBe(before);
	});

	it('keeps the order of the read, and its new notes', () => {
		const before = [row('plan')];
		const read = keptRows(byId(before), [row('new'), row('plan')]);
		expect(read.map(({ id }) => id)).toEqual(['new', 'plan']);
		expect(read[1]).toBe(before[0]);
	});
});
