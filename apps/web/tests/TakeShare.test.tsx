import { MAX_ATTACHMENT_BYTES, readClipName } from '@skysa/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHARE_CACHE } from '../src/share/received.js';
import { TakeShare, whatCame } from '../src/share/TakeShare.js';
import { createDatabase, type NotesDatabase, type SyncStateRecord } from '../src/store/db.js';
import { fakeCaches } from './fakeCaches.js';

/**
 * Something shared to the app, put to the user before it goes on a clipboard
 * (docs/ARCHITECTURE.md §8, "Shared to the app"): always asked, since another
 * site can post to `/share` as well as the share sheet can, and let go of
 * whatever the answer.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const DROPBOX: SyncStateRecord = {
	connectionId: 'c1',
	clientId: 'install',
	rootId: 'root',
	provider: 'dropbox',
};

interface Kept {
	text?: string;
	files?: { name: string; type?: string; content?: string; size?: number }[];
}

/** A share as the worker keeps it (`receiveShare`, held to this by `share.test.ts`). */
const keep = async (storage: CacheStorage, { text = '', files = [] }: Kept) => {
	const cache = await storage.open(SHARE_CACHE);
	const listed = files.map(({ name, type = '', content = '', size }, part) => ({
		name,
		type,
		size: size ?? content.length,
		part: (size ?? 0) > MAX_ATTACHMENT_BYTES ? null : part,
	}));
	await Promise.all(
		files.flatMap(({ content = '' }, part) =>
			listed[part]?.part === null
				? []
				: [cache.put(`/share/${ID}/${String(part)}`, new Response(content))]
		)
	);
	await cache.put(`/share/${ID}`, new Response(JSON.stringify({ text, files: listed })));
};

const setup = async ({
	source = DROPBOX,
	kept = { text: 'Meet at 3', files: [{ name: 'q3.pdf', content: '%PDF' }] },
	share = ID,
}: { source?: SyncStateRecord | null; kept?: Kept | null; share?: string } = {}) => {
	const db = createDatabase(`take-share-${crypto.randomUUID()}`);
	opened.push(db);
	if (source !== null) await db.syncState.put(source);
	const { storage, urls } = fakeCaches();
	if (kept !== null) await keep(storage, kept);
	const sync = {
		clipboard: {
			refresh: vi.fn(() => Promise.resolve()),
			flush: vi.fn(() => Promise.resolve()),
			read: vi.fn(() => Promise.resolve({ state: 'gone' as const })),
		},
	};
	const onRead = vi.fn();
	const onAdded = vi.fn();
	render(
		<TakeShare
			share={share}
			source={source === null ? null : await db.syncState.get(source.connectionId)}
			sources={[{ connectionId: 'c1', provider: 'dropbox', boundAt: 1, active: true }]}
			onRead={onRead}
			onAdded={onAdded}
			database={db}
			sync={sync}
			storage={storage}
		/>
	);
	const clips = () => db.clips.where('connectionId').equals('c1').toArray();
	const left = () => urls(SHARE_CACHE);
	return { db, sync, onRead, onAdded, clips, left };
};

const shown: SyncStateRecord = { ...DROPBOX, clipboard: true };

describe('something shared to the app', () => {
	it('is put to the user, and goes on the clipboard showing once they say so', async () => {
		const { sync, onRead, onAdded, clips, left } = await setup({ source: shown });
		const dialog = await screen.findByRole('alertdialog', { name: 'Add to the clipboard?' });
		expect(dialog.textContent).toContain(
			"“Meet at 3” and q3.pdf will go on Dropbox's clipboard, which its other devices show too."
		);
		expect(dialog.textContent).not.toContain('This shows the clipboard');
		expect(onRead).toHaveBeenCalledTimes(1);
		expect(await clips()).toEqual([]);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Add to clipboard' }));
		await waitFor(() => {
			expect(onAdded).toHaveBeenCalled();
		});
		const rows = await clips();
		expect(rows.map((row) => readClipName(row.name)?.label).sort()).toEqual(['Text', 'q3.pdf']);
		expect(rows.every((row) => row.state === 'pending')).toBe(true);
		expect(sync.clipboard.flush).toHaveBeenCalledWith('c1');
		expect(sync.clipboard.refresh).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(left()).toEqual([]);
		});
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('shows the clipboard where it was hidden, when the user says to', async () => {
		const { db, sync, clips } = await setup();
		const dialog = await screen.findByRole('alertdialog', { name: 'Add to the clipboard?' });
		expect(dialog.textContent).toContain('This shows the clipboard on this device.');

		await userEvent
			.setup()
			.click(screen.getByRole('button', { name: 'Show clipboard and add' }));
		await waitFor(async () => {
			expect(await clips()).toHaveLength(2);
		});
		expect((await db.syncState.get('c1'))?.clipboard).toBe(true);
		expect(sync.clipboard.refresh).toHaveBeenCalledWith('c1');
	});

	it('is let go of, and nothing added, on Cancel', async () => {
		const { db, onAdded, clips, left } = await setup();
		await screen.findByRole('alertdialog', { name: 'Add to the clipboard?' });

		await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => {
			expect(left()).toEqual([]);
		});
		expect(await clips()).toEqual([]);
		expect((await db.syncState.get('c1'))?.clipboard).toBeUndefined();
		expect(onAdded).not.toHaveBeenCalled();
	});

	it('says what was too large to keep beside what was not', async () => {
		await setup({
			source: shown,
			kept: {
				text: 'see this',
				files: [{ name: 'film.mov', size: MAX_ATTACHMENT_BYTES + 1 }],
			},
		});
		const dialog = await screen.findByRole('alertdialog', { name: 'Add to the clipboard?' });
		expect(dialog.textContent).toContain(
			'film.mov is larger than 25 MB, the most the clipboard takes, and is left out.'
		);
	});

	it('adds nothing, and says why, where everything was too large', async () => {
		const { clips, left } = await setup({
			source: shown,
			kept: { files: [{ name: 'film.mov', size: MAX_ATTACHMENT_BYTES + 1 }] },
		});
		const dialog = await screen.findByRole('dialog', {
			name: 'Nothing was added to the clipboard',
		});
		expect(dialog.textContent).toContain('film.mov is larger than 25 MB');

		await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(left()).toEqual([]);
		});
		expect(await clips()).toEqual([]);
	});

	it('adds nothing to the notes kept on this device only, and says why', async () => {
		const { left } = await setup({ source: null });
		const dialog = await screen.findByRole('dialog', {
			name: 'Nothing was added to the clipboard',
		});
		expect(dialog.textContent).toContain(
			'notes kept on this device only have none. Connect a storage account'
		);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(left()).toEqual([]);
		});
	});

	it('adds nothing to a source no longer connected', async () => {
		const { clips } = await setup({
			source: { ...shown, detached: { at: 1, reason: 'disconnected' } },
		});
		const dialog = await screen.findByRole('dialog', {
			name: 'Nothing was added to the clipboard',
		});
		expect(dialog.textContent).toContain('Dropbox is no longer connected');
		expect(await clips()).toEqual([]);
	});

	it('asks nothing of a share there is none of, and lets the URL go of it', async () => {
		const { onRead } = await setup({ kept: null });
		await waitFor(() => {
			expect(onRead).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});

describe('what came, in a phrase', () => {
	it('quotes the words, cut short, and names the files', () => {
		const file = (name: string) =>
			({ kind: 'file', name, type: '', bytes: new ArrayBuffer(0) }) as const;
		expect(whatCame({ inputs: [{ kind: 'text', text: 'a\n b' }], tooLarge: [] })).toBe('“a b”');
		expect(
			whatCame({ inputs: [file('a.pdf'), file('b.png'), file('c.txt')], tooLarge: [] })
		).toBe('3 files (a.pdf, b.png, c.txt)');
		const long = 'x'.repeat(200);
		expect(whatCame({ inputs: [{ kind: 'text', text: long }], tooLarge: [] })).toBe(
			`“${'x'.repeat(80)}…”`
		);
	});
});
