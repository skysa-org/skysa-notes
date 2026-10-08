import { type NoteRecord } from './db.js';

/** A field of a row, the same in both: its value, or each of its tags. */
const same = (a: unknown, b: unknown): boolean =>
	Object.is(a, b) ||
	(Array.isArray(a) &&
		Array.isArray(b) &&
		a.length === b.length &&
		a.every((each, at) => Object.is(each, b[at])));

const sameRow = (a: NoteRecord, b: NoteRecord): boolean => {
	const fields = Object.keys(a) as (keyof NoteRecord)[];
	return (
		fields.length === Object.keys(b).length &&
		fields.every((field) => Object.hasOwn(b, field) && same(a[field], b[field]))
	);
};

/**
 * What a query read, with each note that has not changed since the read
 * before handed back as the object it was then. A query hands back new objects
 * every time it runs — after every autosave, every sync run — and a list that
 * tells its rows apart by identity, as `NoteList` does, would otherwise draw
 * every one of them again for one note saved.
 */
export const keptRows = (
	before: ReadonlyMap<string, NoteRecord>,
	read: readonly NoteRecord[]
): NoteRecord[] =>
	read.map((row) => {
		const was = before.get(row.id);
		return was !== undefined && sameRow(was, row) ? was : row;
	});
