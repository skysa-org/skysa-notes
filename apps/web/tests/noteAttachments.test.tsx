import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createNoteAttachments,
	LARGE_PICTURE_BYTES,
	type NoteAttachmentsOptions,
	useNoteAttachments,
} from '../src/components/noteAttachments.js';
import type { AttachmentProblem, Shown } from '../src/editor/attachHost.js';
import { createObjectUrlCache, type ObjectUrlFactory } from '../src/editor/objectUrls.js';
import {
	createDatabase,
	type FileRecord,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import { createNote, draftNote } from '../src/store/notes.js';
import type { FileRead } from '../src/sync/fileReads.js';
import type { SchedulerStatus, SyncScheduler } from '../src/sync/scheduler.js';

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
	const where = { current: { connectionId: 'c1', id: 'n1', path: 'notes/day.md' } };
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

		where.current = { connectionId: 'c1', id: 'n1', path: 'archive/day.md' };

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

	it('downloads nothing that is not a kind of picture a browser can be relied on to draw', async () => {
		const { db, show, readFile } = setup();
		await db.files.put(row('notes/page.html'));
		await db.files.put(row('notes/report.pdf'));
		await db.files.put(row('notes/IMG_0001.heic'));

		expect(await show('page.html')).toEqual({ state: 'unsupported' });
		expect(await show('report.pdf')).toEqual({ state: 'unsupported' });
		expect(await show('IMG_0001.heic')).toEqual({ state: 'unsupported' });
		expect(readFile).not.toHaveBeenCalled();
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

describe('a file beside the open note, asked for whole', () => {
	const fetchFile = (host: ReturnType<typeof setup>['host'], href: string) =>
		host.fetchFile(href, new AbortController().signal);

	it('is the file as it is stored, typed as this app may open it, whatever its size', async () => {
		const { db, host, readFile } = setup();
		await db.files.put(row('notes/q3-1a2b3c4d.pdf', { size: LARGE_PICTURE_BYTES * 2 }));
		await db.files.put(row('notes/page.html'));

		const pdf = await fetchFile(host, 'q3-1a2b3c4d.pdf');
		const page = await fetchFile(host, 'page.html');

		expect(readFile).toHaveBeenCalledWith(
			'c1',
			'notes/q3-1a2b3c4d.pdf',
			expect.any(AbortSignal)
		);
		expect(pdf.state === 'ready' && [pdf.file.name, pdf.file.type]).toEqual([
			'q3-1a2b3c4d.pdf',
			'application/pdf',
		]);
		expect(pdf.state === 'ready' && (await pdf.file.text())).toBe('far');
		expect(page.state === 'ready' && page.file.type).toBe('application/octet-stream');
	});

	it.each([
		[{ state: 'gone' }, { state: 'missing' }],
		[{ state: 'offline' }, { state: 'offline' }],
		[{ state: 'unavailable' }, { state: 'unavailable' }],
		[{ state: 'failed' }, { state: 'failed' }],
		[{ state: 'aborted' }, { state: 'aborted' }],
	] as const)('is %o read as %o', async (read, fetched) => {
		const { db, host } = setup(read);
		await db.files.put(row('notes/a.pdf'));

		expect(await fetchFile(host, 'a.pdf')).toEqual(fetched);
	});

	it('is missing where no file is, and failed where the store cannot be read', async () => {
		const { db, host, readFile } = setup();

		expect(await fetchFile(host, 'a.pdf')).toEqual({ state: 'missing' });
		db.close();
		expect(await fetchFile(host, 'a.pdf')).toEqual({ state: 'failed' });
		expect(readFile).not.toHaveBeenCalled();
	});

	it('passes on what the editor could not do', () => {
		const told = vi.fn();
		const host = createNoteAttachments({
			db: freshDatabase(),
			note: () => ({ connectionId: 'c1', id: 'n1', path: 'a.md' }),
			readFile: vi.fn(),
			report: told,
		});

		host.report({ message: 'a.pdf could not be downloaded.', tone: 'error' });

		expect(told).toHaveBeenCalledWith({
			message: 'a.pdf could not be downloaded.',
			tone: 'error',
		});
	});
});

describe('a file added to the open note', () => {
	const opened = async () => {
		const db = freshDatabase();
		const note = await createNote(db, {
			title: 'Day',
			connectionId: 'c1',
			folderPath: 'notes',
		});
		const host = createNoteAttachments({ db, note: () => note, readFile: vi.fn() });
		return { db, host };
	};
	const pdf = () => new File(['%PDF-1.7'], 'Q3 report.pdf', { type: 'application/pdf' });

	it('is put beside the note, and the editor told how to link it', async () => {
		const { db, host } = await opened();

		const added = await host.add(pdf(), { pasted: false });

		expect(added).toMatchObject({ state: 'added', kind: 'file', label: 'Q3 report.pdf' });
		const href = added.state === 'added' ? added.href : '';
		expect(href).toMatch(/^q3-report-[0-9a-f]{8}\.pdf$/);
		expect(added.state === 'added' && added.markdown).toBe(`[Q3 report.pdf](${href})`);
		expect((await db.files.toArray()).map((file) => file.path)).toEqual([`notes/${href}`]);
	});

	it('is the file already there when the same bytes are added again', async () => {
		const { db, host } = await opened();

		const first = await host.add(pdf(), { pasted: false });
		const again = await host.add(pdf(), { pasted: false });

		expect(again).toEqual(first);
		expect(await db.files.count()).toBe(1);
	});

	it('is refused when too large, before a byte of it is read', async () => {
		const { db, host } = await opened();
		const film = new File(['x'], 'film.mov');
		Object.defineProperty(film, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
		const read = vi.spyOn(film, 'arrayBuffer');

		expect(await host.add(film, { pasted: false })).toEqual({
			state: 'refused',
			reason: 'too-large',
		});
		expect(read).not.toHaveBeenCalled();
		expect(await db.files.count()).toBe(0);
	});

	it('is refused when it is a note', async () => {
		const { host } = await opened();

		expect(await host.add(new File(['# Other'], 'other.md'), { pasted: false })).toEqual({
			state: 'refused',
			reason: 'note',
		});
	});

	it('stores a note that is a draft first, as its first keystroke would', async () => {
		const db = freshDatabase();
		const draft = draftNote({ connectionId: 'c1', folderPath: 'notes', taken: [] });
		const store = vi.fn(async () => {
			await db.notes.add(draft);
			return true;
		});
		const host = createNoteAttachments({ db, note: () => draft, readFile: vi.fn(), store });

		const added = await host.add(pdf(), { pasted: false });

		expect(store).toHaveBeenCalledTimes(1);
		expect(added).toMatchObject({ state: 'added', kind: 'file' });
		expect(await db.files.count()).toBe(1);
	});

	it('stores no draft for a file it refuses or cannot read: that would be an empty note', async () => {
		const db = freshDatabase();
		const draft = draftNote({ connectionId: 'c1', folderPath: 'notes', taken: [] });
		const store = vi.fn(() => Promise.resolve(true));
		const host = createNoteAttachments({ db, note: () => draft, readFile: vi.fn() });
		const storing = createNoteAttachments({ db, note: () => draft, readFile: vi.fn(), store });
		const unreadable = new File(['x'], 'folder');
		vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error('a folder'));
		const note = new File(['# Other'], 'other.md');
		const read = vi.spyOn(note, 'arrayBuffer');

		expect(await storing.add(note, { pasted: false })).toEqual({
			state: 'refused',
			reason: 'note',
		});
		expect(await storing.add(unreadable, { pasted: false })).toEqual({ state: 'failed' });

		expect(store).not.toHaveBeenCalled();
		// A note is refused before a byte of it is read, as one too large is.
		expect(read).not.toHaveBeenCalled();
		expect(await host.add(note, { pasted: false })).toMatchObject({ state: 'refused' });
	});

	it('goes beside the note it was put in, though another is open by the time the draft is stored', async () => {
		const db = freshDatabase();
		const draft = draftNote({ connectionId: 'c1', folderPath: 'notes', taken: [] });
		const other = await createNote(db, {
			title: 'Other',
			connectionId: 'c1',
			folderPath: 'elsewhere',
		});
		const open: { current: NoteRecord } = { current: draft };
		const host = createNoteAttachments({
			db,
			note: () => open.current,
			readFile: vi.fn(),
			store: async () => {
				open.current = other;
				await db.notes.add(draft);
				return true;
			},
		});

		const added = await host.add(pdf(), { pasted: false });

		expect(added.state).toBe('added');
		expect((await db.files.toArray()).map((file) => file.path)).toEqual([
			expect.stringMatching(/^notes\/q3-report-[0-9a-f]{8}\.pdf$/),
		]);
	});

	it('has failed where a draft could not be stored, and adds nothing', async () => {
		const db = freshDatabase();
		const draft = draftNote({ connectionId: 'c1', folderPath: 'notes', taken: [] });
		const host = createNoteAttachments({
			db,
			note: () => draft,
			readFile: vi.fn(),
			store: () => Promise.resolve(false),
		});

		expect(await host.add(pdf(), { pasted: false })).toEqual({ state: 'failed' });
		expect(await db.files.count()).toBe(0);
	});

	it('has failed where the store cannot take it', async () => {
		const { db, host } = await opened();
		db.close();

		expect(await host.add(pdf(), { pasted: false })).toEqual({ state: 'failed' });
	});

	it('is a pasted picture by the name a pasted picture has', async () => {
		const { host } = await opened();

		const added = await host.add(new File(['png'], 'image.png', { type: 'image/png' }), {
			pasted: true,
		});

		expect(added).toMatchObject({ state: 'added', kind: 'image', label: 'Pasted image' });
		expect(added.state === 'added' && added.href).toMatch(/^pasted-image-[0-9a-f]{8}\.png$/);
	});
});

describe('files picked for the open note', () => {
	const picking = () => {
		const report = vi.fn<(problem: AttachmentProblem) => void>();
		const host = createNoteAttachments({
			db: freshDatabase(),
			note: () => ({ connectionId: 'c1', id: 'n1', path: 'a.md' }),
			readFile: vi.fn(),
			report,
		});
		return { host, report };
	};

	const picker = (): HTMLInputElement => {
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (input === null) throw new Error('no picker is open');
		return input;
	};

	const choose = (files: File[]) => {
		const input = picker();
		Object.defineProperty(input, 'files', { value: files });
		input.dispatchEvent(new Event('change'));
	};

	const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it('are asked for at once, inside the press that asked for them', () => {
		const click = vi.spyOn(HTMLInputElement.prototype, 'click');
		const { host } = picking();

		host.pick();

		expect(click).toHaveBeenCalledOnce();
	});

	it('go into the editor open now', async () => {
		const { host, report } = picking();
		const receiver = vi.fn();
		host.receive(receiver);
		const files = [new File(['a'], 'a.pdf')];

		host.pick();
		choose(files);
		await settled();

		expect(receiver).toHaveBeenCalledWith(files);
		expect(report).not.toHaveBeenCalled();
	});

	it('go nowhere, and nothing is said, where none is chosen', async () => {
		const { host, report } = picking();
		const receiver = vi.fn();
		host.receive(receiver);

		host.pick();
		picker().dispatchEvent(new Event('cancel'));
		await settled();

		expect(receiver).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it('are said to be for adding again where no editor is open by then', async () => {
		const { host, report } = picking();
		const withdraw = host.receive(vi.fn());

		host.pick();
		withdraw();
		choose([new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')]);
		await settled();

		expect(report).toHaveBeenCalledWith({
			message: 'The editor closed before 2 files could go in. Add them again to put them in.',
			tone: 'warning',
		});
	});

	it('go into the editor that offered itself last, though the one before goes after it', async () => {
		const { host } = picking();
		const before = vi.fn();
		const after = vi.fn();
		const withdrawBefore = host.receive(before);
		host.receive(after);

		// The switch from one mode to the other: the new editor is there first.
		withdrawBefore();
		host.pick();
		choose([new File(['a'], 'a.pdf')]);
		await settled();

		expect(after).toHaveBeenCalledOnce();
		expect(before).not.toHaveBeenCalled();
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
		const statuses = new Set<(status: SchedulerStatus) => void>();
		const subscribe: SyncScheduler['subscribe'] = (listener) => {
			statuses.add(listener);
			return () => {
				statuses.delete(listener);
			};
		};
		const synced = (lastSyncAt?: number) => {
			statuses.forEach((listener) => {
				listener({ phase: 'idle', conflicts: [], lastSyncAt });
			});
		};
		const hook = renderHook(
			({ current }: { current: NoteRecord }) =>
				useNoteAttachments(current, { readFile, db, subscribe }),
			{ initialProps: { current: note } }
		);
		const heard = vi.fn();
		hook.result.current.changed(heard);
		return { db, note, hook, heard, synced, statuses };
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

	it('tells its views when a sync has run, which a source that could not be read may now be', async () => {
		const { hook, heard, synced, statuses } = await mounted();
		heard.mockClear();

		act(() => {
			synced(1000);
			// Every other status a run goes through says nothing new.
			synced(1000);
		});
		expect(heard).toHaveBeenCalledTimes(1);
		act(() => {
			synced(2000);
		});
		expect(heard).toHaveBeenCalledTimes(2);

		hook.unmount();
		expect(statuses.size).toBe(0);
	});

	it('passes on a problem to whoever the note view says now', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { title: 'Day', connectionId: 'c1' });
		const first = vi.fn();
		const second = vi.fn();
		const hook = renderHook(
			({ report }: { report: (problem: AttachmentProblem) => void }) =>
				useNoteAttachments(note, {
					readFile: vi.fn(),
					db,
					subscribe: () => () => undefined,
					report,
				}),
			{ initialProps: { report: first } }
		);

		hook.rerender({ report: second });
		hook.result.current.report({ message: 'No.', tone: 'error' });

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith({ message: 'No.', tone: 'error' });
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
