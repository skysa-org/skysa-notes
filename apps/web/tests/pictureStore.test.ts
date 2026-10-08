import {
	createFakeProvider,
	createSyncEngine,
	type PictureInfo,
	type PictureVariant,
} from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, detachConnection, releaseConnection } from '../src/store/connection.js';
import { createDatabase, type FileRecord, type NotesDatabase } from '../src/store/db.js';
import { TOUCH_AFTER_MS } from '../src/store/fileCache.js';
import { deleteUnlinkedFiles } from '../src/store/fileLinks.js';
import { addAttachment } from '../src/store/files.js';
import { createFolder, deleteFolder } from '../src/store/folders.js';
import { createNote, moveNote, saveNoteBody } from '../src/store/notes.js';
import {
	evictPictures,
	heldCopy,
	heldPicture,
	keepPicture,
	type MadeCopy,
	PICTURE_BUDGET_BYTES,
	THUMB_SHARE,
} from '../src/store/pictures.js';
import { seenIn, unsyncedIn } from '../src/store/unsynced.js';
import { createDexieSyncStore } from '../src/sync/store.js';

/**
 * What a device keeps of the pictures beside notes (#276): what each one's
 * header says, and the smaller copies made of it, for as long as its row is
 * bound to the bytes they were read from.
 */

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`pictures-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const INFO: PictureInfo = {
	format: 'jpeg',
	width: 4032,
	height: 3024,
	animated: false,
	alpha: false,
	orientation: 1,
};

const made = (variant: PictureVariant, size = 100): MadeCopy => ({
	variant,
	bytes: new Uint8Array(size).fill(7).buffer,
	type: 'image/webp',
	width: variant === 'thumb' ? 512 : 1280,
	height: variant === 'thumb' ? 384 : 960,
});

const boundRow = (id: string, version = 'v1'): FileRecord => ({
	connectionId: CONNECTION,
	id,
	path: `Work/${id}.jpg`,
	remoteId: `r-${id}`,
	remoteVersion: version,
	size: 5_000_000,
});

const copiesOf = async (db: NotesDatabase, id: string) =>
	Object.keys((await db.pictures.get([CONNECTION, id]))?.copies ?? {}).sort();

const bytesHeld = async (db: NotesDatabase) =>
	(await db.pictureBytes.toCollection().primaryKeys())
		.map(([, id, variant]) => `${id}:${variant}`)
		.sort();

describe('a picture as this device keeps it', () => {
	it('keeps what its header says and a copy, and hands the copy back', async () => {
		const db = freshDatabase();
		const file = boundRow('a');
		await db.files.put(file);

		expect(await keepPicture(db, file, { info: INFO, copy: made('w1280') }, 1_000)).toBe(true);

		expect(await heldPicture(db, CONNECTION, 'a')).toMatchObject({
			info: INFO,
			remoteId: 'r-a',
			version: 'v1',
			copies: { w1280: { type: 'image/webp', width: 1280, height: 960, size: 100 } },
		});
		const copy = await heldCopy(db, CONNECTION, 'a', 'w1280', 1_000);
		expect(copy).toMatchObject({ type: 'image/webp', width: 1280, height: 960 });
		expect(copy?.bytes.byteLength).toBe(100);
		expect(await heldCopy(db, CONNECTION, 'a', 'thumb', 1_000)).toBeUndefined();
	});

	it('keeps a header alone, and a copy beside the ones there already', async () => {
		const db = freshDatabase();
		const file = boundRow('a');
		await db.files.put(file);
		await keepPicture(db, file, { info: null }, 0);
		expect(await heldPicture(db, CONNECTION, 'a')).toMatchObject({ info: null, copies: {} });

		await keepPicture(db, file, { info: INFO, copy: made('thumb') }, 0);
		await keepPicture(db, file, { info: INFO, copy: made('w960') }, 0);

		expect(await copiesOf(db, 'a')).toEqual(['thumb', 'w960']);
	});

	it('is nothing once its row is bound to other bytes, and is let go of for them', async () => {
		const db = freshDatabase();
		const file = boundRow('a');
		await db.files.put(file);
		await keepPicture(db, file, { info: INFO, copy: made('thumb') }, 0);

		// Another device wrote other bytes over it.
		await db.files.put(boundRow('a', 'v2'));

		expect(await heldPicture(db, CONNECTION, 'a')).toBeUndefined();
		expect(await heldCopy(db, CONNECTION, 'a', 'thumb', 0)).toBeUndefined();
		await keepPicture(db, boundRow('a', 'v2'), { info: INFO, copy: made('w960') }, 0);
		expect(await copiesOf(db, 'a')).toEqual(['w960']);
		expect(await bytesHeld(db)).toEqual(['a:w960']);
	});

	it('stays refused by the browser while it is these bytes, and no longer once it is others', async () => {
		const db = freshDatabase();
		const file = boundRow('a');
		await db.files.put(file);
		await keepPicture(db, file, { info: INFO, refused: true }, 0);
		// Read again without the browser asked, and still said.
		await keepPicture(db, file, { info: INFO }, 0);
		expect(await heldPicture(db, CONNECTION, 'a')).toMatchObject({ refused: true });

		await db.files.put(boundRow('a', 'v2'));
		await keepPicture(db, boundRow('a', 'v2'), { info: INFO }, 0);

		expect(await heldPicture(db, CONNECTION, 'a')).not.toHaveProperty('refused');
	});

	it('is not kept for a row that has gone, or moved on from the bytes it was read from', async () => {
		const db = freshDatabase();
		expect(await keepPicture(db, boundRow('a'), { info: INFO, copy: made('thumb') }, 0)).toBe(
			false
		);
		await db.files.put(boundRow('a', 'v2'));
		expect(await keepPicture(db, boundRow('a'), { info: INFO, copy: made('thumb') }, 0)).toBe(
			false
		);
		expect(await db.pictures.count()).toBe(0);
		expect(await db.pictureBytes.count()).toBe(0);
	});

	it('writes a use back to its record only once it is an hour stale', async () => {
		const db = freshDatabase();
		const file = boundRow('a');
		await db.files.put(file);
		await keepPicture(db, file, { info: INFO, copy: made('thumb') }, 1_000);
		const usedAt = async () =>
			(await db.pictures.get([CONNECTION, 'a']))?.copies.thumb?.lastUsedAt;

		await heldCopy(db, CONNECTION, 'a', 'thumb', 1_000 + TOUCH_AFTER_MS - 1);
		expect(await usedAt()).toBe(1_000);
		await heldCopy(db, CONNECTION, 'a', 'thumb', 1_000 + TOUCH_AFTER_MS);
		expect(await usedAt()).toBe(1_000 + TOUCH_AFTER_MS);
	});
});

describe('the copies a device keeps, over budget', () => {
	it('lets go of the least recently used first, and of every thumb last', async () => {
		const db = freshDatabase();
		await Promise.all(['a', 'b', 'c'].map((id) => db.files.put(boundRow(id))));
		// Within budget as each is kept, so nothing goes until asked.
		await keepPicture(db, boundRow('a'), { info: INFO, copy: made('thumb') }, 1);
		await keepPicture(db, boundRow('b'), { info: INFO, copy: made('w1280') }, 2);
		await keepPicture(db, boundRow('c'), { info: INFO, copy: made('w960') }, 3);
		await keepPicture(db, boundRow('c'), { info: INFO, copy: made('thumb') }, 4);

		// Both thumbs, 200 bytes, are within the share of 280 kept for them.
		expect(200).toBeLessThanOrEqual(280 * THUMB_SHARE);
		expect(await evictPictures(db, 280)).toBe(2);

		// The two width copies went, b's the older; both thumbs, older still, stay.
		expect(await bytesHeld(db)).toEqual(['a:thumb', 'c:thumb']);
		expect(await copiesOf(db, 'b')).toEqual([]);
		expect(await copiesOf(db, 'c')).toEqual(['thumb']);
		// And b's header, which costs nothing to keep.
		expect((await heldPicture(db, CONNECTION, 'b'))?.info).toEqual(INFO);
	});

	it('lets go of everything kept for a row that has gone, or for bytes it has moved on from', async () => {
		const db = freshDatabase();
		await Promise.all(['a', 'b', 'c'].map((id) => db.files.put(boundRow(id))));
		await Promise.all(
			['a', 'b', 'c'].map((id) =>
				keepPicture(db, boundRow(id), { info: INFO, copy: made('thumb') }, 0)
			)
		);
		await db.files.delete([CONNECTION, 'a']);
		await db.files.put(boundRow('b', 'v2'));

		expect(await evictPictures(db, PICTURE_BUDGET_BYTES)).toBe(2);

		expect((await db.pictures.toArray()).map((picture) => picture.fileId)).toEqual(['c']);
		expect(await bytesHeld(db)).toEqual(['c:thumb']);
	});

	it('lets the oldest thumbs go as any copy does, past their share of the budget', async () => {
		const db = freshDatabase();
		await Promise.all(['a', 'b', 'c'].map((id) => db.files.put(boundRow(id))));
		await keepPicture(db, boundRow('a'), { info: INFO, copy: made('thumb') }, 1);
		await keepPicture(db, boundRow('b'), { info: INFO, copy: made('w1280') }, 2);
		await keepPicture(db, boundRow('c'), { info: INFO, copy: made('thumb') }, 3);

		// Room for one thumb in the share: a's, the older, goes before b's copy.
		expect(await evictPictures(db, 100 / THUMB_SHARE + 100)).toBe(1);

		expect(await bytesHeld(db)).toEqual(['b:w1280', 'c:thumb']);
	});

	it('never lets go of the copy it has just kept, though a thumb goes for it', async () => {
		const db = freshDatabase();
		await Promise.all(['a', 'b'].map((id) => db.files.put(boundRow(id))));
		await keepPicture(db, boundRow('a'), { info: INFO, copy: made('thumb') }, 1, 150);

		await keepPicture(db, boundRow('b'), { info: INFO, copy: made('w1280') }, 2, 150);

		expect(await bytesHeld(db)).toEqual(['b:w1280']);
	});

	it('is kept within budget as each copy is kept', async () => {
		const db = freshDatabase();
		await Promise.all(['a', 'b'].map((id) => db.files.put(boundRow(id))));
		await keepPicture(db, boundRow('a'), { info: INFO, copy: made('w1280') }, 1, 150);
		await keepPicture(db, boundRow('b'), { info: INFO, copy: made('w1280') }, 2, 150);

		expect(await bytesHeld(db)).toEqual(['b:w1280']);
	});
});

/** The app's writers, the Dexie store and the engine, over the fake provider. */
const connected = async () => {
	const db = freshDatabase();
	await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engine = createSyncEngine({
		provider: fake,
		store: createDexieSyncStore(db, scope),
		now: () => new Date('2026-10-08T10:00:00Z'),
	});
	return { db, fake, engine };
};

/** A note in `folder` with a picture beside it, and what was read of the picture. */
const noteWithPicture = async (db: NotesDatabase, folder = 'Work') => {
	const note = await createNote(db, { ...scope, folderPath: folder, title: 'Trip' });
	const added = await addAttachment(db, {
		...scope,
		noteId: note.id,
		name: 'photo.jpg',
		bytes: new TextEncoder().encode('a photo').buffer,
	});
	await saveNoteBody(db, note.id, `${added.markdown}\n`, undefined, scope);
	const row = await db.files.get([CONNECTION, added.fileId]);
	if (row === undefined) throw new Error('no row');
	await keepPicture(db, row, { info: INFO, copy: made('thumb') }, 0);
	return { note, fileId: added.fileId };
};

describe('a picture beside a note, as it syncs', () => {
	it('is still what was read of it once it is uploaded', async () => {
		const { db, engine } = await connected();
		const { fileId } = await noteWithPicture(db);
		expect((await heldPicture(db, CONNECTION, fileId))?.remoteId).toBeUndefined();

		expect((await engine.sync()).status).toBe('ok');

		const row = await db.files.get([CONNECTION, fileId]);
		expect(row?.remoteId).toBeDefined();
		expect(await heldPicture(db, CONNECTION, fileId)).toMatchObject({
			remoteId: row?.remoteId,
			version: row?.remoteVersion,
		});
		expect(await heldCopy(db, CONNECTION, fileId, 'thumb', 0)).toBeDefined();
	});

	it('is not what was uploaded where the upload read its bytes again from elsewhere', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Play' });
		const { note, fileId } = await noteWithPicture(db);
		const other = await createNote(db, { ...scope, folderPath: 'Work', title: 'Also' });
		const linked = await db.notes.get([CONNECTION, note.id]);
		await saveNoteBody(db, other.id, linked?.body ?? '', undefined, scope);
		expect((await engine.sync()).status).toBe('ok');
		await db.fileBytes.clear();

		// Moved away from a note that still links it: a copy of the file, made
		// without its bytes, which the upload reads from the original.
		await moveNote(db, note.id, 'Play', scope);
		const copy = (await db.files.toArray()).find((file) => file.id !== fileId);
		if (copy === undefined) throw new Error('no copy');
		expect(copy.remoteId).toBeUndefined();
		expect(await keepPicture(db, copy, { info: INFO, copy: made('thumb') }, 0)).toBe(true);
		const original = await db.files.get([CONNECTION, fileId]);
		fake.plantBytes(original?.path ?? '', new TextEncoder().encode('another photo'));

		expect((await engine.sync()).status).toBe('ok');

		const uploaded = await db.files.get([CONNECTION, copy.id]);
		expect(new TextDecoder().decode(fake.bytesAt(uploaded?.path ?? ''))).toBe('another photo');
		expect(await heldPicture(db, CONNECTION, copy.id)).toBeUndefined();
	});

	it('is still what was read of it once it has moved with its note', async () => {
		const { db, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Play' });
		const { note, fileId } = await noteWithPicture(db);
		await engine.sync();
		const before = await db.files.get([CONNECTION, fileId]);

		await moveNote(db, note.id, 'Play', scope);
		expect((await engine.sync()).status).toBe('ok');

		const after = await db.files.get([CONNECTION, fileId]);
		expect(after?.path.startsWith('Play/')).toBe(true);
		expect(after?.remoteVersion).not.toBe(before?.remoteVersion);
		expect(await heldPicture(db, CONNECTION, fileId)).toMatchObject({
			version: after?.remoteVersion,
		});
	});

	it('goes with its file, deleted on another device', async () => {
		const { db, fake, engine } = await connected();
		const { fileId } = await noteWithPicture(db);
		await engine.sync();
		const row = await db.files.get([CONNECTION, fileId]);
		const remote = fake.snapshot().find((entry) => entry.path === row?.path);
		if (remote === undefined) throw new Error('not on the remote');

		await fake.delete(remote);
		expect((await engine.sync()).status).toBe('ok');

		expect(await db.files.get([CONNECTION, fileId])).toBeUndefined();
		expect(await db.pictures.count()).toBe(0);
		expect(await db.pictureBytes.count()).toBe(0);
	});
});

describe('a picture beside a note, deleted here', () => {
	it('goes with its notebook', async () => {
		const db = freshDatabase();
		await noteWithPicture(db);

		await deleteFolder(db, 'Work', scope);

		expect(await db.pictures.count()).toBe(0);
		expect(await db.pictureBytes.count()).toBe(0);
	});

	it('goes with its file, once no note links it', async () => {
		const db = freshDatabase();
		const { note, fileId } = await noteWithPicture(db);
		await saveNoteBody(db, note.id, 'No pictures now\n', undefined, scope);

		expect(await deleteUnlinkedFiles(db, CONNECTION, [fileId])).toHaveLength(1);

		expect(await db.pictures.count()).toBe(0);
		expect(await db.pictureBytes.count()).toBe(0);
	});

	it('goes with a source the user lets go of', async () => {
		const db = freshDatabase();
		await bindConnection(db, {
			connectionId: CONNECTION,
			provider: 'dropbox',
			accountId: 'dbid:ada',
		});
		await noteWithPicture(db);
		await detachConnection(db, { connectionId: CONNECTION });
		const seen = seenIn(await unsyncedIn(db, CONNECTION));

		expect(
			await releaseConnection(db, { connectionId: CONNECTION, unsynced: 'discard', seen })
		).toBe('released');

		expect(await db.pictures.count()).toBe(0);
		expect(await db.pictureBytes.count()).toBe(0);
	});
});
