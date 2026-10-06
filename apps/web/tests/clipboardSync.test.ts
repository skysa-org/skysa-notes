import {
	basename,
	bytesHash,
	CLIPBOARD_FOLDER,
	CLIPBOARD_ITEMS,
	clipName,
	createFakeProvider,
	type FakeProvider,
	MAX_ATTACHMENT_BYTES,
	readClipName,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	addClips,
	type ClipInput,
	listClips,
	removeClip,
	setClipboardShown,
} from '../src/store/clipboard.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { type ClipboardSession, createClipboardSync } from '../src/sync/clipboard.js';

/**
 * The clipboard a source's devices share (docs/ARCHITECTURE.md §7, "The
 * clipboard"): what a paste does here at once (`store/clipboard.ts`), and how
 * that reaches the folder and comes back from it (`sync/clipboard.ts`).
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const AT = Date.UTC(2026, 9, 6, 15, 30, 12, 123);

const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const decode = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);

const text = (value: string): ClipInput => ({ kind: 'text', text: value });
const file = (name: string, value: string, type = ''): ClipInput => ({
	kind: 'file',
	name,
	type,
	bytes: encode(value).slice().buffer,
});

const setup = async ({ shown = true }: { shown?: boolean } = {}) => {
	const db = createDatabase(`clipboard-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({
		connectionId: 'c1',
		clientId: 'install',
		rootId: 'root',
		...(shown ? { clipboard: true as const } : {}),
	});
	const fake: FakeProvider = createFakeProvider();
	await fake.ensureRoot();
	const told = vi.fn();
	const live = new Set<'on'>(['on']);
	const network = new Set<'up'>(['up']);
	const provider: { current: StorageProvider } = { current: fake };
	const session = (): ClipboardSession => ({
		provider: provider.current,
		withAuth: (work) => work(),
		told,
		idle: () => Promise.resolve(),
	});
	const sync = createClipboardSync({
		db,
		sessionFor: (connectionId) =>
			connectionId === 'c1' && live.has('on') ? session() : undefined,
		isOnline: () => network.has('up'),
	});
	/** What the folder holds, by name. */
	const remote = async (): Promise<string[]> =>
		(await fake.list(CLIPBOARD_FOLDER).catch(() => []))
			.map((entry) => basename(entry.path))
			.sort();
	/** Another device's paste, straight into the folder. */
	const pastedElsewhere = async (name: string, value: string) => {
		await fake.createFolder(CLIPBOARD_FOLDER);
		return fake.createFile(`${CLIPBOARD_FOLDER}/${name}`, encode(value));
	};
	const rows = () => db.clips.where('connectionId').equals('c1').toArray();
	return { db, fake, sync, told, live, network, provider, remote, pastedElsewhere, rows };
};

/** The name a text pasted at `at` is given. */
const textName = async (value: string, at: number): Promise<string> =>
	clipName({ at, hash: await bytesHash(encode(value)), text: true });

describe('pasting here', () => {
	it('goes in at once, waiting to be sent, with its bytes and the start of a text', async () => {
		const { db } = await setup();

		const { added, tooLarge } = await addClips(db, 'c1', [text('hello')], AT);

		expect(tooLarge).toEqual([]);
		expect(added).toEqual([await textName('hello', AT)]);
		expect(await listClips(db, 'c1')).toEqual([
			{ connectionId: 'c1', name: added[0], state: 'pending', size: 5, preview: 'hello' },
		]);
		const held = await db.clipBytes.get(['c1', added[0] ?? '']);
		expect(decode(held?.bytes ?? new ArrayBuffer(0))).toBe('hello');
	});

	it('lists newest first, each paste stamped after the newest item known', async () => {
		const { db } = await setup();
		await addClips(db, 'c1', [text('first')], AT);
		// A clock behind the one that stamped the first.
		await addClips(db, 'c1', [text('second'), file('Q3 Report.pdf', '%PDF')], AT - 60_000);

		const listed = (await listClips(db, 'c1')).map((row) => readClipName(row.name));
		expect(listed.map((read) => read?.label)).toEqual(['q3-report.pdf', 'Text', 'Text']);
		expect(listed.map((read) => read?.at)).toEqual([AT + 2, AT + 1, AT]);
	});

	it('refuses what is larger than an item may be, by name, and takes the rest', async () => {
		const { db } = await setup();
		const huge: ClipInput = {
			kind: 'file',
			name: 'film.mov',
			type: 'video/quicktime',
			bytes: new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1),
		};

		const { added, tooLarge } = await addClips(db, 'c1', [huge, text('small')], AT);

		expect(tooLarge).toEqual(['film.mov']);
		expect(added).toHaveLength(1);
	});

	it('moves something pasted again to the top, rather than holding it twice', async () => {
		const { db, sync, remote } = await setup();
		const [first = ''] = (await addClips(db, 'c1', [text('same')], AT)).added;
		await sync.flush('c1');
		await addClips(db, 'c1', [text('other')], AT + 10);

		const [again = ''] = (await addClips(db, 'c1', [text('same')], AT + 20)).added;

		expect((await listClips(db, 'c1')).map((row) => row.name)).toEqual([
			again,
			await textName('other', AT + 10),
		]);
		// Sent, so the remote is told: it goes there too, at the next flush.
		expect((await db.clips.get(['c1', first]))?.state).toBe('removing');
		await sync.flush('c1');
		expect(await remote()).toEqual([await textName('other', AT + 10), again].sort());
	});

	it(`keeps the newest ${String(CLIPBOARD_ITEMS)}, letting go of the oldest`, async () => {
		const { db, sync, remote } = await setup();
		await addClips(db, 'c1', [text('item 0')], AT);
		await sync.flush('c1');
		await Promise.all(
			Array.from({ length: CLIPBOARD_ITEMS - 1 }, (_, n) =>
				text(`item ${String(n + 1)}`)
			).map((input, n) => addClips(db, 'c1', [input], AT + 1000 * (n + 1)))
		);
		expect(await listClips(db, 'c1')).toHaveLength(CLIPBOARD_ITEMS);

		await addClips(db, 'c1', [text('one more')], AT + 100_000);

		const shown = await listClips(db, 'c1');
		expect(shown).toHaveLength(CLIPBOARD_ITEMS);
		expect(shown.map((row) => row.preview)).not.toContain('item 0');
		await sync.flush('c1');
		expect(await remote()).toHaveLength(CLIPBOARD_ITEMS);
		expect(await remote()).not.toContain(await textName('item 0', AT));
	});

	it('puts nothing on a source that is gone, or detached', async () => {
		const { db } = await setup();
		await db.syncState.update('c1', { detached: { at: AT, reason: 'disconnected' } });

		expect((await addClips(db, 'c1', [text('x')], AT)).added).toEqual([]);
		expect((await addClips(db, 'c9', [text('x')], AT)).added).toEqual([]);
		expect(await db.clips.count()).toBe(0);
	});
});

describe('removing here', () => {
	it('forgets an item never sent, and marks a sent one to be removed there', async () => {
		const { db, sync, remote } = await setup();
		const [sent = ''] = (await addClips(db, 'c1', [text('sent')], AT)).added;
		await sync.flush('c1');
		const [unsent = ''] = (await addClips(db, 'c1', [text('unsent')], AT + 1)).added;

		await removeClip(db, 'c1', unsent);
		await removeClip(db, 'c1', sent);

		expect(await db.clips.get(['c1', unsent])).toBeUndefined();
		expect((await db.clips.get(['c1', sent]))?.state).toBe('removing');
		expect(await listClips(db, 'c1')).toEqual([]);
		expect(await db.clipBytes.count()).toBe(0);

		await sync.flush('c1');
		expect(await remote()).toEqual([]);
		expect(await db.clips.count()).toBe(0);
	});
});

describe('sending', () => {
	it('makes the folder, sends what is waiting, and tells the other devices once', async () => {
		const { db, sync, told, remote } = await setup();
		const { added } = await addClips(db, 'c1', [text('a'), file('notes.zip', 'PK')], AT);

		await sync.flush('c1');

		expect(await remote()).toEqual([...added].sort());
		expect((await listClips(db, 'c1')).map((row) => row.state)).toEqual(['sent', 'sent']);
		expect(told).toHaveBeenCalledTimes(1);
		// A text's bytes show it, and stay; a file's are the remote's now.
		const [pasted = '', zip = ''] = added;
		expect(await db.clipBytes.get(['c1', pasted])).toBeDefined();
		expect(await db.clipBytes.get(['c1', zip])).toBeUndefined();
	});

	it('tells nobody when there was nothing to send', async () => {
		const { sync, told } = await setup();
		await sync.flush('c1');
		expect(told).not.toHaveBeenCalled();
	});

	it('takes its own earlier upload, whose answer was lost, for what it is', async () => {
		const { db, sync, fake, told } = await setup();
		const [name = ''] = (await addClips(db, 'c1', [text('twice')], AT)).added;
		await fake.createFolder(CLIPBOARD_FOLDER);
		await fake.createFile(`${CLIPBOARD_FOLDER}/${name}`, encode('twice'));

		await sync.flush('c1');

		expect((await db.clips.get(['c1', name]))?.state).toBe('sent');
		expect(told).toHaveBeenCalledTimes(1);
	});

	it('waits, offline or with no session, and sends when it can', async () => {
		const { db, sync, network, live, remote } = await setup();
		await addClips(db, 'c1', [text('later')], AT);

		network.delete('up');
		await sync.flush('c1');
		network.add('up');
		live.delete('on');
		await sync.flush('c1');
		expect(await remote()).toEqual([]);

		live.add('on');
		await sync.flush('c1');
		expect(await remote()).toHaveLength(1);
	});

	it('leaves an item the provider refused waiting, and sends the rest', async () => {
		const { db, sync, fake, provider, remote } = await setup();
		const { added } = await addClips(db, 'c1', [text('refused'), text('fine')], AT);
		provider.current = {
			...fake,
			createFile: (path, bytes, options) =>
				path.endsWith(added[0] ?? '')
					? Promise.reject(new Error('500'))
					: fake.createFile(path, bytes, options),
		};

		await sync.flush('c1');

		expect(await remote()).toEqual([added[1]]);
		expect((await db.clips.get(['c1', added[0] ?? '']))?.state).toBe('pending');
	});

	it('removes on the remote an item removed while it was going up', async () => {
		const { db, sync, fake, provider, remote } = await setup();
		const [name = ''] = (await addClips(db, 'c1', [text('gone soon')], AT)).added;
		provider.current = {
			...fake,
			createFile: async (path, bytes, options) => {
				await removeClip(db, 'c1', name);
				return fake.createFile(path, bytes, options);
			},
		};

		await sync.flush('c1');
		provider.current = fake;
		await vi.waitFor(async () => {
			expect(await remote()).toEqual([]);
		});
		expect(await db.clips.count()).toBe(0);
	});
});

describe('reading the folder again', () => {
	it('takes in what another device pasted, and reads a text to show it', async () => {
		const { db, sync, pastedElsewhere } = await setup();
		const name = await textName('from the phone', AT);
		await pastedElsewhere(name, 'from the phone');

		await sync.refresh('c1');

		expect(await listClips(db, 'c1')).toEqual([
			expect.objectContaining({ name, state: 'sent', size: 14, preview: 'from the phone' }),
		]);
	});

	it('reads a picture to show it, and leaves a file until it is saved', async () => {
		const { db, sync, pastedElsewhere } = await setup();
		const picture = clipName({ at: AT, hash: 'a'.repeat(8), name: 'x.png', pasted: true });
		const archive = clipName({ at: AT + 1, hash: 'b'.repeat(8), name: 'x.zip' });
		await pastedElsewhere(picture, 'PNG');
		await pastedElsewhere(archive, 'PK');

		await sync.refresh('c1');

		expect(await db.clipBytes.get(['c1', picture])).toBeDefined();
		expect(await db.clipBytes.get(['c1', archive])).toBeUndefined();
		const read = await sync.read('c1', archive);
		expect(read.state === 'ready' ? decode(read.bytes) : read.state).toBe('PK');
		// Read to be saved, not kept.
		expect(await db.clipBytes.get(['c1', archive])).toBeUndefined();
	});

	it('lets go of what another device let go of, and keeps what is still to be sent', async () => {
		const { db, sync, fake, pastedElsewhere } = await setup();
		const theirs = await pastedElsewhere(await textName('theirs', AT), 'theirs');
		await sync.refresh('c1');
		const [mine = ''] = (await addClips(db, 'c1', [text('mine')], AT + 1)).added;
		await fake.delete(theirs);

		await sync.refresh('c1');

		expect((await listClips(db, 'c1')).map((row) => row.name)).toEqual([mine]);
		expect(await db.clipBytes.get(['c1', basename(theirs.path)])).toBeUndefined();
	});

	it('ignores a file in the folder the app did not name', async () => {
		const { db, sync, pastedElsewhere } = await setup();
		await pastedElsewhere('notes.txt', 'someone else’s');

		await sync.refresh('c1');

		expect(await db.clips.count()).toBe(0);
	});

	it('reads nothing where the clipboard is not shown, and does once it is', async () => {
		const { db, sync, pastedElsewhere } = await setup({ shown: false });
		await pastedElsewhere(await textName('waiting', AT), 'waiting');

		await sync.refresh('c1');
		expect(await db.clips.count()).toBe(0);

		await setClipboardShown(db, 'c1', true);
		await sync.refresh('c1');
		expect(await db.clips.count()).toBe(1);
	});

	it('has nothing to show before anything was pasted anywhere', async () => {
		const { db, sync } = await setup();
		await sync.refresh('c1');
		expect(await db.clips.count()).toBe(0);
	});
});

describe('reading an item', () => {
	it('answers from the bytes held here, and says why where it cannot', async () => {
		const { db, sync, live, pastedElsewhere } = await setup();
		const [held = ''] = (await addClips(db, 'c1', [text('held')], AT)).added;
		const archive = clipName({ at: AT + 1, hash: 'b'.repeat(8), name: 'x.zip' });
		await pastedElsewhere(archive, 'PK');
		await sync.refresh('c1');

		const read = await sync.read('c1', held);
		expect(read.state === 'ready' ? decode(read.bytes) : read.state).toBe('held');
		expect(await sync.read('c1', 'nothing')).toEqual({ state: 'gone' });
		live.delete('on');
		expect(await sync.read('c1', archive)).toEqual({ state: 'unavailable' });
	});
});

describe('showing it', () => {
	it('is this device’s choice, kept on the source’s row', async () => {
		const { db } = await setup({ shown: false });
		await setClipboardShown(db, 'c1', true);
		expect((await db.syncState.get('c1'))?.clipboard).toBe(true);
		await setClipboardShown(db, 'c1', false);
		expect((await db.syncState.get('c1'))?.clipboard).toBeUndefined();
	});
});
