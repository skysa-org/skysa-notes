import { createFakeProvider, createSyncEngine, isHidden, MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, detachConnection, finishImport } from '../src/store/connection.js';
import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { zipOf } from '../src/store/exportNotes.js';
import { createFolder } from '../src/store/folders.js';
import {
	acceptedName,
	bringsAnything,
	importLibrary,
	type ImportPlan,
	ImportRefusedError,
	type Picked,
	planImport,
	readPicked,
} from '../src/store/importLibrary.js';
import { createNote, importNoteFile } from '../src/store/notes.js';
import { createDexieSyncStore } from '../src/sync/store.js';

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`import-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** A bound source whose first import is through, so it takes an import of files. */
const bound = async (): Promise<NotesDatabase> => {
	const db = freshDatabase();
	await bindConnection(db, { connectionId: CONNECTION, provider: 'dropbox' });
	await finishImport(db, CONNECTION);
	return db;
};

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

const picked = (
	files: Record<string, string | Uint8Array<ArrayBuffer>>,
	folders: string[] = []
): Picked => ({
	files: Object.entries(files).map(([path, content]) => ({
		path,
		bytes: typeof content === 'string' ? bytes(content) : content,
	})),
	folders,
	skipped: [],
});

/** Latin-1 `é`, which is no UTF-8 sequence. */
const LATIN1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

const liveNotes = async (db: NotesDatabase) =>
	(await db.notes.where('connectionId').equals(CONNECTION).toArray())
		.filter((note) => note.deletedLocally === 0)
		.map((note) => note.path)
		.sort();

describe('acceptedName', () => {
	it('keeps every name a provider takes exactly as it is', () => {
		[
			'BNI (Evernote import on 2016-06-30T21-49-30)',
			"david.e.furman@gmail.com's Notebook",
			'05 - 60 Second Presentations.md',
			'Café #1 & more!.md',
			'Pages 1-100',
		].forEach((name) => {
			expect(acceptedName(name)).toBe(name);
		});
	});

	it('changes only what a provider would refuse', () => {
		expect(acceptedName('a:b?.md')).toBe('a_b_.md');
		expect(acceptedName('trailing. ')).toBe('trailing');
		expect(acceptedName('  leading')).toBe('leading');
		expect(acceptedName('CON.md')).toBe('CON_.md');
		expect(acceptedName('com1')).toBe('com1_');
		expect(acceptedName('...')).toBe('_');
	});
});

describe('planImport', () => {
	it('takes notes and files at their paths, and every notebook they are in, outermost first', () => {
		const plan = planImport(
			picked(
				{
					'Work/Meetings/standup.md': '# Standup\n',
					'Work/photo.png': 'png',
					'top.md': 'x',
				},
				['Empty/']
			)
		);

		expect(plan.notes.map((note) => note.path)).toEqual(['Work/Meetings/standup.md', 'top.md']);
		expect(plan.files.map((file) => file.path)).toEqual(['Work/photo.png']);
		expect(plan.folders).toEqual(['Empty', 'Work', 'Work/Meetings']);
		expect(plan.skipped).toEqual([]);
	});

	it('leaves out a note that is not UTF-8 text, and says so', () => {
		const plan = planImport(picked({ 'Recipes/Mici.md': LATIN1, 'Recipes/ok.md': 'ok' }));

		expect(plan.notes.map((note) => note.path)).toEqual(['Recipes/ok.md']);
		expect(plan.skipped).toEqual([{ path: 'Recipes/Mici.md', reason: 'not-text' }]);
	});

	it('takes a file that is not UTF-8, which is no note', () => {
		expect(planImport(picked({ 'a.bin': LATIN1 })).files).toHaveLength(1);
	});

	it('leaves out what the system put there, without a word', () => {
		const plan = planImport(
			picked({
				'.DS_Store': 'x',
				'Misc/.DS_Store': 'x',
				'__MACOSX/Misc/._a.md': 'x',
				'Misc/Thumbs.db': 'x',
				'Misc/desktop.ini': 'x',
				'Misc/a.md': 'a',
			})
		);

		expect(plan.notes.map((note) => note.path)).toEqual(['Misc/a.md']);
		expect(plan.files).toEqual([]);
		expect(plan.skipped).toEqual([]);
	});

	it('says which notes it leaves out for being hidden, and not what a tool keeps hidden', () => {
		const plan = planImport(
			picked({
				'BlueSky/_versions/.14 TODO - version 28.md': 'x',
				'.obsidian/app.json': '{}',
				'.git/HEAD': 'ref',
				'.trash/old.md': 'gone',
				'Misc/._a.md': 'apple double',
			})
		);

		expect(plan.notes).toEqual([]);
		expect(plan.files).toEqual([]);
		expect(plan.skipped).toEqual([
			{ path: 'BlueSky/_versions/.14 TODO - version 28.md', reason: 'hidden' },
			{ path: '.trash/old.md', reason: 'hidden' },
		]);
	});

	it('changes a name a provider would refuse, and says which', () => {
		const plan = planImport(picked({ 'Q&A: 2024?/notes.md': 'x' }));

		expect(plan.notes.map((note) => note.path)).toEqual(['Q&A_ 2024_/notes.md']);
		expect(plan.renamed).toEqual(['Q&A: 2024?/notes.md']);
	});

	it('reads a backslash as a separator and climbs out of nothing', () => {
		const plan = planImport(picked({ 'Work\\plan.md': 'x', '../../escape.md': 'y' }));

		expect(plan.notes.map((note) => note.path)).toEqual(['Work/plan.md', 'escape.md']);
	});

	it('brings nothing from a pick of nothing it can use', () => {
		expect(bringsAnything(planImport(picked({ '.DS_Store': 'x' })))).toBe(false);
	});
});

describe('importLibrary', () => {
	it('brings the notes in as the files they were, owed to the remote, and the remote gets exactly them', async () => {
		const db = await bound();
		const plan = planImport(
			picked(
				{
					'Recipes/Food/02 - Mici.md':
						'---\ntitle: "Mici"\n---\n\n# Mici\n\n![](assets/image.jpg)\n',
					'Recipes/Food/assets/image.jpg': Uint8Array.from([0xff, 0xd8, 0xff]),
					'README.md': '# All notebooks\r\n',
				},
				['Empty/']
			)
		);

		const outcome = await importLibrary(db, CONNECTION, plan);

		expect(outcome).toEqual({ notes: 2, files: 1, folders: 4, numbered: 0, present: 0 });
		const notes = await db.notes.where('connectionId').equals(CONNECTION).toArray();
		expect(notes.every((note) => note.dirty === 1)).toBe(true);
		expect(notes.find((note) => note.path === 'Recipes/Food/02 - Mici.md')?.title).toBe('Mici');

		const fake = createFakeProvider();
		await fake.ensureRoot();
		const engine = createSyncEngine({ provider: fake, store: createDexieSyncStore(db, scope) });
		expect((await engine.sync()).status).toBe('ok');

		expect(
			fake
				.snapshot()
				.filter((entry) => !isHidden(entry.path))
				.map((entry) => [entry.kind, entry.path])
		).toEqual([
			['folder', 'Empty'],
			['file', 'README.md'],
			['folder', 'Recipes'],
			['folder', 'Recipes/Food'],
			['file', 'Recipes/Food/02 - Mici.md'],
			['folder', 'Recipes/Food/assets'],
			['file', 'Recipes/Food/assets/image.jpg'],
		]);
		// Byte for byte: no frontmatter added, no line ending changed.
		expect(fake.contentAt('README.md')).toBe('# All notebooks\r\n');
		expect(fake.contentAt('Recipes/Food/02 - Mici.md')).toBe(
			'---\ntitle: "Mici"\n---\n\n# Mici\n\n![](assets/image.jpg)\n'
		);
		expect([...(fake.bytesAt('Recipes/Food/assets/image.jpg') ?? [])]).toEqual([
			0xff, 0xd8, 0xff,
		]);

		// And once it is up, there is nothing left to send.
		expect(await db.opQueue.where('connectionId').equals(CONNECTION).count()).toBe(0);
		const after = await db.notes.where('connectionId').equals(CONNECTION).toArray();
		expect(after.every((note) => note.dirty === 0)).toBe(true);
	});

	it('goes into the notebooks the source has, as the source spells them, and numbers a name that is taken', async () => {
		const db = await bound();
		await importNoteFile(db, { ...scope, path: 'Work/Plan.md', source: '# Mine\n' });

		const outcome = await importLibrary(
			db,
			CONNECTION,
			planImport(picked({ 'work/plan.md': '# Theirs\n', 'work/other.md': 'o' }))
		);

		expect(outcome.numbered).toBe(1);
		expect(outcome.folders).toBe(0);
		expect(await liveNotes(db)).toEqual(['Work/Plan.md', 'Work/other.md', 'Work/plan-2.md']);
		const mine = await db.notes
			.where('[connectionId+path]')
			.equals([CONNECTION, 'Work/Plan.md'])
			.first();
		expect(mine?.body).toBe('# Mine\n');
		expect(mine?.dirty).toBe(0);
	});

	it('numbers two picked names one provider would call one', async () => {
		const db = await bound();

		await importLibrary(db, CONNECTION, planImport(picked({ 'Plan.md': 'a', 'plan.md': 'b' })));

		expect(await liveNotes(db)).toEqual(['Plan.md', 'plan-2.md']);
	});

	it('imports the same archive twice as two copies, with ids of their own and the files once', async () => {
		const db = await bound();
		const archive = planImport(
			picked({
				'a.md': '---\nid: 0b6c5c3e-9f43-4f0e-9a4e-6b8a7e1c2d3f\n---\n\nA\n',
				'pic.png': 'png',
			})
		);

		await importLibrary(db, CONNECTION, archive);
		const again = await importLibrary(db, CONNECTION, archive);

		expect(again).toMatchObject({ notes: 1, files: 0, present: 1, numbered: 1 });
		const ids = (await db.notes.where('connectionId').equals(CONNECTION).toArray()).map(
			(note) => note.id
		);
		expect(ids).toContain('0b6c5c3e-9f43-4f0e-9a4e-6b8a7e1c2d3f');
		expect(new Set(ids).size).toBe(2);
		expect(await db.files.where('connectionId').equals(CONNECTION).count()).toBe(1);
	});

	it('puts a file beside one of its name and another size, keeping its extension', async () => {
		const db = await bound();
		await importLibrary(db, CONNECTION, planImport(picked({ 'img/a.png': 'one' })));

		await importLibrary(db, CONNECTION, planImport(picked({ 'img/a.png': 'three' })));

		const paths = (await db.files.where('connectionId').equals(CONNECTION).toArray())
			.map((file) => file.path)
			.sort();
		expect(paths).toHaveLength(2);
		expect(paths).toContain('img/a.png');
		expect(paths.find((path) => path !== 'img/a.png')).toMatch(/^img\/a \(conflict .+\)\.png$/);
	});

	it('makes only the notebooks that are not there yet', async () => {
		const db = await bound();
		await createFolder(db, { ...scope, name: 'Work' });

		const outcome = await importLibrary(
			db,
			CONNECTION,
			planImport(picked({}, ['work/', 'New/']))
		);

		expect(outcome.folders).toBe(1);
		const mkdirs = (await db.opQueue.where('connectionId').equals(CONNECTION).toArray())
			.filter((op) => op.op === 'mkdir')
			.map((op) => op.path);
		expect(mkdirs).toEqual(['Work', 'New']);
	});

	it("goes into the device's own notes when nothing is connected", async () => {
		const db = freshDatabase();
		await createNote(db, { connectionId: LOCAL_CONNECTION_ID, title: 'Already here' });

		const outcome = await importLibrary(
			db,
			LOCAL_CONNECTION_ID,
			planImport(picked({ 'Ideas/one.md': '# One\n' }))
		);

		expect(outcome.notes).toBe(1);
		expect(
			(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).toArray())
				.map((note) => note.path)
				.sort()
		).toEqual(['Ideas/one.md', 'already-here.md']);
	});

	it('refuses a source still filling with its first import, and a detached one', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: CONNECTION, provider: 'dropbox' });
		const plan: ImportPlan = planImport(picked({ 'a.md': 'a' }));

		await expect(importLibrary(db, CONNECTION, plan)).rejects.toBeInstanceOf(
			ImportRefusedError
		);

		await finishImport(db, CONNECTION);
		await createNote(db, { ...scope, title: 'Unsent' });
		await detachConnection(db, { connectionId: CONNECTION });
		await expect(importLibrary(db, CONNECTION, plan)).rejects.toBeInstanceOf(
			ImportRefusedError
		);
		expect(await db.notes.where('path').equals('a.md').count()).toBe(0);
	});
});

describe('readPicked', () => {
	const fileAt = (relative: string, content: BlobPart): File => {
		const file = new File([content], relative.split('/').at(-1) ?? relative);
		Object.defineProperty(file, 'webkitRelativePath', { value: relative });
		return file;
	};

	it('takes a folder from inside it: the folder picked is not a notebook', async () => {
		const read = await readPicked(
			[fileAt('all-notebooks/Misc/a.md', 'A'), fileAt('all-notebooks/README.md', 'R')],
			'folder'
		);

		expect(read.files.map((file) => file.path)).toEqual(['Misc/a.md', 'README.md']);
	});

	it('unpacks an archive, keeps a loose note, and says which archive it could not read', async () => {
		const archive = zipOf([{ path: 'Work/plan.md', content: 'P' }], [{ path: 'Empty' }]);

		const read = await readPicked(
			[
				new File([archive], 'notes.zip', { type: 'application/zip' }),
				new File(['loose'], 'loose.md'),
				new File(['not a zip'], 'broken.zip'),
			],
			'files'
		);

		expect(read.files.map((file) => [file.path, new TextDecoder().decode(file.bytes)])).toEqual(
			[
				['Work/plan.md', 'P'],
				['loose.md', 'loose'],
			]
		);
		expect(read.folders).toEqual(['Empty/']);
		expect(read.skipped).toEqual([{ path: 'broken.zip', reason: 'unreadable' }]);
	});

	it('leaves out a file over the limit without reading it', async () => {
		const huge = new File(['x'], 'film.mov');
		Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });

		const read = await readPicked([huge], 'files');

		expect(read).toEqual({
			files: [],
			folders: [],
			skipped: [{ path: 'film.mov', reason: 'too-large' }],
		});
	});
});
