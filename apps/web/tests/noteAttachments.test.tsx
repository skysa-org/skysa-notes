import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createNoteAttachments,
	LARGE_PICTURE_BYTES,
	type NoteAttachmentsOptions,
	useNoteAttachments,
} from '../src/components/noteAttachments.js';
import type { Shown } from '../src/editor/attachHost.js';
import { createObjectUrlCache, type ObjectUrlFactory } from '../src/editor/objectUrls.js';
import {
	createDatabase,
	type FileRecord,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import type { FileRead } from '../src/sync/fileReads.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`note-attachments-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const bufferOf = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

const row = (path: string, overrides: Partial<FileRecord> = {}): FileRecord => ({
	connectionId: 'c1',
	id: path,
	path,
	remoteId: `r-${path}`,
	remoteVersion: 'v1',
	size: 3,
	...overrides,
});

/** URLs as jsdom cannot make them, each blob kept to be looked at. */
const objectUrls = () => {
	const made: Blob[] = [];
	const revoked: string[] = [];
	const factory: ObjectUrlFactory = {
		create: (blob) => {
			made.push(blob);
			return `blob:test/${String(made.length)}`;
		},
		revoke: (url) => {
			revoked.push(url);
		},
	};
	return { urls: createObjectUrlCache(factory, 0), made, revoked };
};

/**
 * The files beside `notes/day.md` in `c1`, read from the remote by a fake that
 * answers `answer` and counts what it was asked.
 */
const setup = (answer: FileRead = { state: 'ready', bytes: bufferOf('far') }) => {
	const db = freshDatabase();
	const where = { current: { connectionId: 'c1', path: 'notes/day.md' } };
	const readFile = vi.fn<NoteAttachmentsOptions['readFile']>(() => Promise.resolve(answer));
	const { urls, made, revoked } = objectUrls();
	const host = createNoteAttachments({ db, note: () => where.current, readFile, urls });
	const show = (href: string, large?: boolean): Promise<Shown> =>
		host.show(href, { signal: new AbortController().signal, large });
	return { db, where, readFile, host, show, made, revoked };
};

const urlOf = (shown: Shown): string | undefined =>
	shown.state === 'ready' ? shown.url : undefined;

describe('a picture beside the open note', () => {
	it('is missing when no file is where the link says, or the link leaves the library', async () => {
		const { db, show, readFile } = setup();
		await db.files.put(row('notes/cat.png'));

		expect(await show('dog.png')).toEqual({ state: 'missing' });
		expect(await show('../../cat.png')).toEqual({ state: 'missing' });
		expect(readFile).not.toHaveBeenCalled();
	});

	it('is drawn from the bytes on the device, without asking the remote', async () => {
		const { db, show, readFile, made } = setup();
		await db.files.put(row('notes/cat.png', { remoteId: undefined, remoteVersion: undefined }));
		await db.fileBytes.put({
			connectionId: 'c1',
			id: 'notes/cat.png',
			bytes: bufferOf('cat'),
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(urlOf(await show('cat.png'))).toBe('blob:test/1');
		expect(readFile).not.toHaveBeenCalled();
		expect(made[0]?.type).toBe('image/png');
		expect(await made[0]?.text()).toBe('cat');
	});

	it('is read from the remote when the device does not hold it', async () => {
		const { db, show, readFile, made } = setup();
		await db.files.put(row('notes/cat.png'));

		expect(urlOf(await show('cat.png'))).toBe('blob:test/1');
		expect(readFile).toHaveBeenCalledWith('c1', 'notes/cat.png', expect.any(AbortSignal));
		expect(await made[0]?.text()).toBe('far');
	});

	it('is resolved from where the note is now, not where it was when the host was made', async () => {
		const { db, where, show } = setup();
		await db.files.put(row('notes/cat.png'));
		await db.files.put(row('archive/cat.png', { id: 'moved' }));

		where.current = { connectionId: 'c1', path: 'archive/day.md' };

		expect(urlOf(await show('cat.png'))).toBe('blob:test/1');
		expect(await show('../notes/cat.png')).toMatchObject({ state: 'ready' });
	});

	it('waits to be asked for a large one it does not hold, and reads it when asked', async () => {
		const { db, show, readFile } = setup();
		await db.files.put(row('notes/map.png', { size: LARGE_PICTURE_BYTES + 1 }));
		await db.files.put(row('notes/edge.png', { size: LARGE_PICTURE_BYTES }));

		expect(await show('map.png')).toEqual({ state: 'large', size: LARGE_PICTURE_BYTES + 1 });
		expect(readFile).not.toHaveBeenCalled();
		expect(await show('edge.png')).toMatchObject({ state: 'ready' });
		expect(await show('map.png', true)).toMatchObject({ state: 'ready' });
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it.each([
		[{ state: 'gone' }, { state: 'missing' }],
		[{ state: 'offline' }, { state: 'offline' }],
		[{ state: 'unavailable' }, { state: 'unavailable' }],
		[{ state: 'failed' }, { state: 'failed' }],
		[{ state: 'aborted' }, { state: 'aborted' }],
	] as const)('is %o read as %o', async (read, shown) => {
		const { db, show } = setup(read);
		await db.files.put(row('notes/cat.png'));

		expect(await show('cat.png')).toEqual(shown);
	});

	it('opens a file that is not a picture as nothing a browser would run', async () => {
		const { db, show, made } = setup();
		await db.files.put(row('notes/page.html'));

		await show('page.html');

		expect(made[0]?.type).toBe('application/octet-stream');
	});

	it('draws an SVG from a data: URL, never a blob: one, which would be the app', async () => {
		const { db, show, made } = setup({
			state: 'ready',
			bytes: bufferOf('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		});
		await db.files.put(row('notes/logo.svg'));

		const url = urlOf(await show('logo.svg'));

		expect(url?.startsWith('data:image/svg+xml;base64,')).toBe(true);
		expect(atob(url?.split(',')[1] ?? '')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
		expect(made).toEqual([]);
	});

	it('shares one URL between the views of a picture, reading it once', async () => {
		const { db, show, readFile, made } = setup();
		await db.files.put(row('notes/cat.png'));

		const first = await show('cat.png');
		const second = await show('cat.png');

		expect(urlOf(second)).toBe(urlOf(first));
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(made).toHaveLength(1);
	});

	it('is another picture, under another URL, once the remote has a new version of the file', async () => {
		const { db, show, readFile, revoked } = setup();
		await db.files.put(row('notes/cat.png'));
		const first = await show('cat.png');

		await db.files.put(row('notes/cat.png', { remoteVersion: 'v2' }));
		const second = await show('cat.png');

		expect(urlOf(second)).not.toBe(urlOf(first));
		expect(readFile).toHaveBeenCalledTimes(2);
		if (first.state === 'ready') first.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(revoked).toEqual(['blob:test/1']);
	});

	it('tells every view when links may resolve differently, until it stops', () => {
		const { host } = setup();
		const heard = vi.fn();
		const stop = host.changed(heard);

		host.notify();
		stop();
		host.notify();

		expect(heard).toHaveBeenCalledTimes(1);
	});

	it('lets go of every URL it made when the note closes', async () => {
		const { db, host, show, revoked } = setup();
		await db.files.put(row('notes/a.png'));
		await db.files.put(row('notes/b.png'));
		await show('a.png');
		await show('b.png');

		host.dispose();

		expect(revoked.sort()).toEqual(['blob:test/1', 'blob:test/2']);
	});
});

describe('the host of the open note', () => {
	const mounted = async () => {
		const db = freshDatabase();
		const note = await createNote(db, {
			title: 'Day',
			connectionId: 'c1',
			folderPath: 'notes',
		});
		const readFile = vi.fn<NoteAttachmentsOptions['readFile']>(() =>
			Promise.resolve({ state: 'offline' })
		);
		const hook = renderHook(
			({ current }: { current: NoteRecord }) => useNoteAttachments(current, readFile, db),
			{ initialProps: { current: note } }
		);
		const heard = vi.fn();
		hook.result.current.changed(heard);
		return { db, note, hook, heard };
	};

	it('is one host for the note, whatever of it changes, and tells it when the note moves', async () => {
		const { db, note, hook, heard } = await mounted();
		const host = hook.result.current;
		await db.files.put(row('archive/cat.png'));

		hook.rerender({ current: { ...note, path: 'archive/day.md', title: 'Day!' } });

		expect(hook.result.current).toBe(host);
		expect(heard).toHaveBeenCalled();
		// Resolved from the folder it is in now.
		expect(await host.show('cat.png', { signal: new AbortController().signal })).toEqual({
			state: 'offline',
		});
	});

	it('tells its views when a file arrives in the source, and when the network comes back', async () => {
		const { db, heard } = await mounted();
		heard.mockClear();

		await act(async () => {
			await db.files.put(row('notes/cat.png'));
		});
		await vi.waitFor(() => {
			expect(heard).toHaveBeenCalled();
		});
		heard.mockClear();
		act(() => {
			window.dispatchEvent(new Event('online'));
		});

		expect(heard).toHaveBeenCalledTimes(1);
	});

	it('is a new host for another note, the old one letting go of its URLs', async () => {
		const { db, hook } = await mounted();
		const host = hook.result.current;
		const dispose = vi.spyOn(host, 'dispose');
		const other = await createNote(db, { title: 'Other', connectionId: 'c1' });

		hook.rerender({ current: other });

		expect(hook.result.current).not.toBe(host);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
