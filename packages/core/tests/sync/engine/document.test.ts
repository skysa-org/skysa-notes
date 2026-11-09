import { describe, expect, it } from 'vitest';

import type { SyncNote } from '../../../src/sync/store.js';
import { remoteAt } from '../kit/remote.js';
import { TEXT_FORMAT } from '../kit/textFormat.js';
import { editHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';

/**
 * The engine asks the format it is handed what a document is, and knows no
 * file format of its own (docs/decisions/0018-the-shared-kit.md). Every other
 * engine test runs with markdown (`TEST_FORMAT`); these run with plain text
 * (`TEXT_FORMAT`), the store included, so that anything still reading
 * markdown for itself shows here.
 */
const { world, engineWith, copyId, remoteFile, noteAt, pulledNote } = syncWorld(TEXT_FORMAT);

const textEngine = () => engineWith({ newId: copyId });

describe('an engine handed a format that is not markdown', () => {
	it('makes documents of the files its extension names, and of no others', async () => {
		await remoteFile('a.txt', 'plain\n');
		await remoteFile('b.md', '# not a document here\n');

		expect((await textEngine().pull()).status).toBe('ok');

		expect(world.store.notes().map((note) => note.path)).toEqual(['a.txt']);
		expect(world.store.files().map((file) => file.path)).toEqual(['b.md']);
	});

	it('takes the id a file claims from the format, and none from frontmatter', async () => {
		await remoteFile('a.txt', '@id from-the-format\nbody\n');
		await remoteFile('b.txt', '---\nid: from-frontmatter\n---\nbody\n');

		await textEngine().pull();

		const ids = Object.fromEntries(world.store.notes().map((note) => [note.path, note.id]));
		expect(ids).toEqual({ 'a.txt': 'from-the-format', 'b.txt': 'copy-1' });
	});

	it('holds a file the format refuses as unreadable, and never writes it', async () => {
		await remoteFile('a.txt', 'plain\n');
		await remoteFile('b.txt', 'BINARYÿ\n');

		expect((await textEngine().sync()).status).toBe('ok');

		expect(world.store.storedCursor()).toBeDefined();
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.txt']);
		expect((await world.store.unreadable()).map((file) => file.path)).toEqual(['b.txt']);
		expect(world.provider.contentAt('b.txt')).toBe('BINARYÿ\n');
	});

	it('makes a conflict copy as the format says, named with its extension', async () => {
		const first = await remoteFile('a.txt', 'original\n');
		await textEngine().pull();
		const note = world.store.notes()[0];
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, content: 'mine\n', dirty: true });
		await world.provider.write('a.txt', 'theirs\n', { expectedVersion: first.version });

		const result = await textEngine().pull();

		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).txt']);
		// Its text is the format's, claiming the copy's own id: the note took
		// the first one the engine gave out.
		const copy = world.store.notes().find((each) => each.path.endsWith('T14-32).txt'));
		expect(copy?.content).toBe('@id copy-2\nmine\n');
	});
});

/**
 * Text the format refuses, met at each read that holds a file as a document
 * (`readDocument`). The cases are `files.test.ts`'s for a file that is not
 * UTF-8; these meet them through the format's half of the rule, where the
 * provider reads the file without complaint. skysa-draw's, for a `.svg` that
 * is not a drawing.
 */
describe('a file the format refuses', () => {
	const REFUSED = new TextEncoder().encode('BINARY, to this format\n');
	const COPY = 'a (conflict 2026-09-15T14-32).txt';

	const holders = (remoteId: string): SyncNote[] =>
		world.store.notes().filter((note) => note.remoteId === remoteId);

	/** What the engine has asked the provider to change. */
	const sent = (): string[] =>
		world.provider
			.callLog()
			.filter((call) => call.op === 'write' || call.op === 'move' || call.op === 'delete')
			.map((call) => `${call.op} ${call.path ?? ''}`);

	const listed = async (): Promise<string[]> =>
		(await world.store.unreadable()).map((file) => `${file.remoteId} ${file.path}`).sort();

	it('lets go of a clean note whose file became one, and sends nothing', async () => {
		const { entry } = await pulledNote('a.txt', 'one\n');
		const before = sent();
		world.provider.plantBytes('a.txt', REFUSED);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(sent()).toEqual(before);
		expect(world.provider.bytesAt('a.txt')).toEqual(REFUSED);
		expect(remoteAt(world.provider, 'a.txt')?.remoteId).toBe(entry.remoteId);
	});

	it('cuts a dirty note loose and moves it aside, and its edit goes up beside the file', async () => {
		const { entry, note } = await pulledNote('a.txt', 'one\n');
		editHere(world.store, note, 'my edit\n');
		world.provider.plantBytes('a.txt', REFUSED);

		expect((await world.engine.pull()).status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: true });
		expect(noteAt('a.txt')).toBeUndefined();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.provider.contentAt(COPY)).toBe('my edit\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.txt')).toEqual(REFUSED);
	});

	it('sets a push’s edit aside in one drain when the note’s own file became one', async () => {
		const { entry, note } = await pulledNote('a.txt', 'one\n');
		editHere(world.store, note, 'my edit\n');
		world.provider.plantBytes('a.txt', REFUSED);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([COPY]);
		expect(world.store.ops()).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(world.provider.contentAt(COPY)).toBe('my edit\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.txt')).toEqual(REFUSED);
		expect(await listed()).toEqual([`${entry.remoteId} a.txt`]);
	});

	it('cuts a note loose when its own file became one and another has its name', async () => {
		// Its own file is there, so a push that meets another file at the
		// note's new name would step aside still bound to it (`fileState`), and
		// its retry be aimed at a file the format will not hold.
		const { entry, note } = await pulledNote('x.txt', 'one\n');
		world.store.put({ ...note, path: 'a.txt', content: 'my edit\n', dirty: true });
		world.store.queue({ op: 'write', noteId: note.id, path: 'a.txt' });
		world.store.queue({ op: 'move', noteId: note.id, path: 'x.txt', targetPath: 'a.txt' });
		await remoteFile('a.txt', 'theirs\n');
		world.provider.plantBytes('x.txt', REFUSED);

		await world.engine.push();
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(world.provider.contentAt(COPY)).toBe('my edit\n');
		expect(world.provider.contentAt('a.txt')).toBe('theirs\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('x.txt')).toEqual(REFUSED);
	});

	it('takes the file in once the format would, by the same remote id', async () => {
		const file = world.provider.plantBytes('a.txt', REFUSED);
		await world.engine.pull();
		await world.provider.write('a.txt', 'fixed\n', { expectedVersion: file.version });

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(await listed()).toEqual([]);
		expect(noteAt('a.txt')).toMatchObject({ content: 'fixed\n', remoteId: file.remoteId });
	});
});
