import { describe, expect, it } from 'vitest';

import { TEXT_FORMAT } from '../kit/textFormat.js';
import { syncWorld } from '../kit/world.js';

/**
 * The engine asks the format it is handed what a document is, and knows no
 * file format of its own (docs/decisions/0018-the-shared-kit.md). Every other
 * engine test runs with notes' (`NOTE_FORMAT`); these run with one that is
 * not (`TEXT_FORMAT`), the store included, so that anything still reading
 * markdown for itself shows here.
 */
const { world, engineWith, copyId, remoteFile } = syncWorld(TEXT_FORMAT);

const textEngine = () => engineWith({ newId: copyId });

describe('an engine handed a format that is not notes’', () => {
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
