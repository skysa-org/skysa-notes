import { type Document, isScalar } from 'yaml';

import { readTime } from '../time.js';
import { recover, type Recovered } from './split.js';

/** The fields the app understands. Every other key is preserved but untouched. */
export interface NoteFrontmatter {
	/** UUID; the stable identity of a note across renames and moves. */
	id?: string;
	title?: string;
	created?: string;
	updated?: string;
	tags?: string[];
	/**
	 * A scratch note pinned to the top of the scratchpad: read only when it is
	 * `true`, and written by deleting the key when it is not.
	 */
	pinned?: boolean;
	/** A scratch note's highlight, by name (`SCRATCH_COLORS` in `scratchpad.ts`). */
	color?: string;
}

export const asString = (value: unknown): string | undefined => {
	if (typeof value === 'string') return value;
	// YAML 1.2's core schema has no timestamp type, so `created: 2026-09-14` reads
	// back as a string. A Date only appears if a file tags one explicitly.
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
};

/**
 * `id` is the note's identity, and downstream it is a primary key: `apps/web`
 * stores the row under it, so a wrong id is not a wrong field — it is a second
 * row for a note that already exists, and the first one, with whatever the user
 * had not yet pushed, is left behind where nothing will look for it again.
 *
 * So this is the one field that has to be right or absent, never approximate.
 * Absent costs a fresh UUID and, for a file at a path the app already knows,
 * not even that: the import falls back to matching on the path. Three ways a
 * recovered id can be wrong, and none of them look wrong:
 *
 * - The error is *in the id itself*. An unterminated quote on the id line
 *   recovers the value one character short, so a UUID comes back 35 characters
 *   long and otherwise perfect. Nothing about the string says so; only the
 *   parser knows, so the parser is asked.
 * - The value is prose the parser made a mapping out of. `id: the blue
 *   notebook` is a plausible line to write in a note and an implausible
 *   identity, and two notes written from one template would share it.
 * - The value is not a string at all. YAML reads `id: 0123` as the number 123
 *   and `id: 1e5` as 100000, so two different files collide on one id and the
 *   app writes the changed value back over what the user had.
 */
const idTruncated = (doc: Document): boolean => {
	const node = doc.get('id', true);
	// `range` is `Range | null`, and null for a node the parser synthesized
	// rather than read — nothing to compare an error position against.
	if (!isScalar(node) || node.range === null || node.range === undefined) return false;
	const [start, valueEnd] = node.range;
	return doc.errors.some((error) => error.pos[0] >= start && error.pos[0] <= valueEnd);
};

const asId = (value: unknown, doc: Document): string | undefined => {
	// Not `asString`: its coercions are convenient for a title and wrong here.
	if (typeof value !== 'string') return undefined;
	if (value.trim() === '') return undefined;
	if (doc.errors.length === 0) return value;
	// Only for a block the parser had to repair. A well-formed file saying
	// `id: my note id` means it, whatever this app would have written.
	return /\s/u.test(value) || idTruncated(doc) ? undefined : value;
};

/**
 * Does this block hold an `id` the user wrote and the app declined to use?
 *
 * Declining is only half of leaving it alone. A note read with no id is given
 * one, and a writer that then sets `id` puts a UUID over `id: 202409141302` —
 * a Zettelkasten id, in the user's own file, gone on the first edit. So
 * `writeFrontmatter` asks this and leaves the key out of what it sets: the line
 * stays exactly as written, and the note is what any note without an id is —
 * known to this device by an id the file never sees, and matched by its path.
 *
 * An `id:` with nothing after it is not a value anyone wrote, and is filled in.
 */
export const frontmatterHasDeclinedId = (frontmatter: string | null): boolean => {
	const recovered = recover(frontmatter);
	if (recovered === undefined) return false;
	const { id } = recovered.record;
	if (id === undefined || id === null) return false;
	if (typeof id === 'string' && id.trim() === '') return false;
	return asId(id, recovered.doc) === undefined;
};

export const asTags = (value: unknown): string[] | undefined => {
	if (typeof value === 'string') {
		const tags = value
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		return tags.length > 0 ? tags : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const tags = value.map(asString).filter((t): t is string => t !== undefined && t.length > 0);
	return tags.length > 0 ? tags : undefined;
};

/** Drop keys whose value is undefined, so `toEqual({})` means "nothing read". */
const defined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/**
 * Read the fields the app cares about. Malformed YAML in a user's file is not an
 * error the user should have to fix: what the parser can recover is read, the
 * raw text is left exactly as it was, and `id` alone is held to a stricter
 * standard because it is the one field that cannot be approximately right.
 */
export const readFrontmatter = (frontmatter: string | null): NoteFrontmatter => {
	const recovered = recover(frontmatter);
	return recovered === undefined ? {} : fieldsOf(recovered);
};

const fieldsOf = ({ record, doc }: Recovered): NoteFrontmatter =>
	defined({
		id: asId(record.id, doc),
		title: asString(record.title),
		created: asString(record.created),
		updated: asString(record.updated),
		tags: asTags(record.tags),
		pinned: record.pinned === true ? true : undefined,
		color:
			typeof record.color === 'string' && record.color.trim() !== ''
				? record.color
				: undefined,
	});

/**
 * Where a note's times are, in the order they are looked for: the app's own
 * key first, then what other tools write. `modified` is OneNote's exporters'
 * and Bear's, `date created` and `date modified` are Obsidian's (its Templater
 * and Front Matter Title plugins), and `lastmod` is Hugo's. Not `date`, which
 * is as often when a post goes out as when it was written.
 */
const CREATED_KEYS = ['created', 'date created'] as const;
const UPDATED_KEYS = ['updated', 'modified', 'date modified', 'lastmod'] as const;

const firstTime = (record: Record<string, unknown>, keys: readonly string[]): number | undefined =>
	keys.reduce<number | undefined>((found, key) => {
		if (found !== undefined) return found;
		const text = asString(record[key]);
		return text === undefined ? undefined : readTime(text);
	}, undefined);

/** When a note was made and last edited, as far as its frontmatter says. */
export interface NoteTimes {
	created?: number;
	/** The last edit, or the creation where no edit is recorded. */
	updated?: number;
}

/**
 * The note's times, read from whichever key holds them (`CREATED_KEYS`,
 * `UPDATED_KEYS`), as instants. A note that says when it was made and not
 * when it was edited was last edited, as far as anyone can tell, then: a
 * library exported from OneNote records `modified` on a fifth of its pages,
 * and the rest showed the day they were imported as the day they were edited.
 * A key whose value is no time is passed over for the next one.
 *
 * Only read. What the app writes back is its own `created` and `updated`, and
 * only when one changes (`writeFrontmatter`); the keys another tool wrote are
 * left as they are.
 */
export const readNoteTimes = (frontmatter: string | null): NoteTimes => {
	const recovered = recover(frontmatter);
	return recovered === undefined ? {} : timesOf(recovered);
};

const timesOf = ({ record }: Recovered): NoteTimes => {
	const created = firstTime(record, CREATED_KEYS);
	const updated = firstTime(record, UPDATED_KEYS) ?? created;
	return defined({ created, updated });
};

/**
 * `readFrontmatter` and `readNoteTimes` together, from one parse of the block:
 * what reading a note file asks of it, on every note a pull brings in.
 */
export const readNoteMetadata = (
	frontmatter: string | null
): Readonly<{ fields: NoteFrontmatter; times: NoteTimes }> => {
	const recovered = recover(frontmatter);
	return recovered === undefined
		? { fields: {}, times: {} }
		: { fields: fieldsOf(recovered), times: timesOf(recovered) };
};
