import { MAX_ATTACHMENT_BYTES, readClipName } from '@skysa/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClipboardPanel, DRAG_GONE_MS } from '../src/components/ClipboardPanel.js';
import { type SystemClipboard, type SystemRead } from '../src/components/systemClipboard.js';
import { type FileBrowser } from '../src/editor/fileActions.js';
import { type ObjectUrlCache } from '../src/editor/objectUrls.js';
import { addClips, type ClipInput } from '../src/store/clipboard.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { type FileRead } from '../src/sync/fileReads.js';

/**
 * A source's clipboard on screen (docs/ARCHITECTURE.md §7, "The clipboard"):
 * the ways in — Paste, a keyboard paste, a drop, Add a file — and what pressing
 * an item does with it.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).slice().buffer;

const setup = async ({ read }: { read?: () => Promise<SystemRead> } = {}) => {
	const db = createDatabase(`clipboard-panel-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({
		connectionId: 'c1',
		clientId: 'install',
		rootId: 'root',
		clipboard: true,
	});
	const sync = {
		clipboard: {
			refresh: vi.fn(() => Promise.resolve()),
			flush: vi.fn(() => Promise.resolve()),
			// What this device holds, as the real read answers first.
			read: vi.fn(async (connectionId: string, name: string): Promise<FileRead> => {
				const held = await db.clipBytes.get([connectionId, name]);
				return held === undefined
					? { state: 'offline' }
					: { state: 'ready', bytes: held.bytes };
			}),
		},
	};
	const written: { type: string; blob: Blob }[] = [];
	const system: SystemClipboard = {
		read: read ?? (() => Promise.resolve({ kind: 'empty' })),
		write: async (type, blob) => {
			written.push({ type, blob: await blob });
		},
	};
	const saved: { file: File; name: string }[] = [];
	const browser: FileBrowser = {
		openTab: () => undefined,
		save: (file, name) => {
			saved.push({ file, name });
		},
		canShare: () => false,
		share: () => Promise.resolve(),
		urlFor: () => 'blob:unused',
	};
	const urls: ObjectUrlCache = {
		acquire: (key) => ({
			url: `blob:${key.split('\u0000')[1] ?? ''}`,
			release: () => undefined,
		}),
		reuse: () => undefined,
		clear: () => undefined,
	};
	const pick = vi.fn(() => Promise.resolve<File[]>([]));
	render(
		<ClipboardPanel
			connectionId="c1"
			database={db}
			sync={sync}
			system={system}
			browser={browser}
			urls={urls}
			pick={pick}
		/>
	);
	const rows = () => db.clips.where('connectionId').equals('c1').toArray();
	return { db, sync, written, saved, pick, rows };
};

const region = () => screen.getByRole('region', { name: 'Clipboard' });

const items = () => within(region()).queryAllByRole('listitem');

const said = () => within(region()).getByRole('status');

const seeded = async (db: NotesDatabase, inputs: readonly ClipInput[]) => {
	const { added } = await addClips(db, 'c1', inputs);
	return added;
};

describe('the clipboard panel', () => {
	it('says what it is for, and how an item is used, while it holds nothing', async () => {
		await setup();
		const empty = await screen.findByText(
			'What you paste here is on your other devices too. Click or tap an item to use it.'
		);
		expect(empty.className).toContain('clipboard-empty');
		expect(region().className).not.toContain('clipboard-filled');
	});

	it('glows while it holds anything', async () => {
		const { db } = await setup();
		await seeded(db, [{ kind: 'text', text: 'kept' }]);

		await waitFor(() => {
			expect(region().className).toContain('clipboard-filled');
		});
	});

	it('puts what Paste reads at the top, greyed out under a spinner until it is up, and asks for it to be sent', async () => {
		const { db, sync, rows } = await setup({
			read: () =>
				Promise.resolve({ kind: 'read', inputs: [{ kind: 'text', text: 'call Ana' }] }),
		});
		await userEvent.setup().click(screen.getByRole('button', { name: 'Paste' }));

		const button = await screen.findByRole('button', { name: 'Copy text, waiting to send' });
		expect(button.textContent).toBe('call Ana');
		const [item] = items();
		expect(item?.className).toContain('clipboard-pending');
		expect(item?.querySelector('.clipboard-progress')).not.toBeNull();
		expect((await rows()).map((row) => row.state)).toEqual(['pending']);
		expect(sync.clipboard.flush).toHaveBeenCalledWith('c1');

		const [row] = await rows();
		if (row === undefined) throw new Error('no row');
		await db.clips.put({ ...row, state: 'sent', remoteId: 'r1', version: 'v1' });
		await screen.findByRole('button', { name: 'Copy text' });
		expect(items()[0]?.className).not.toContain('clipboard-pending');
		expect(items()[0]?.querySelector('.clipboard-progress')).toBeNull();
	});

	it('says why when the browser will not let Paste read the clipboard', async () => {
		const { rows } = await setup({ read: () => Promise.resolve({ kind: 'refused' }) });
		await userEvent.setup().click(screen.getByRole('button', { name: 'Paste' }));

		await waitFor(() => {
			expect(said().textContent).toMatch(
				/did not let the clipboard be read\. Press .+V here instead\./
			);
		});
		expect(await rows()).toEqual([]);
	});

	it('takes a keyboard paste of text, and of files', async () => {
		const { rows } = await setup();
		const typed = fireEvent.paste(region(), {
			clipboardData: {
				files: [],
				getData: (type: string) => (type === 'text/plain' ? 'hello' : ''),
			},
		});
		expect(typed).toBe(false);
		expect(await screen.findByText('hello')).toBeDefined();

		fireEvent.paste(region(), {
			clipboardData: { files: [new File(['%PDF'], 'q3.pdf')], getData: () => '' },
		});
		expect(await screen.findByText('q3.pdf')).toBeDefined();
		const read = (await rows()).map((row) => readClipName(row.name));
		expect(read.map((name) => name?.label ?? name?.kind).sort()).toEqual(['q3.pdf', 'text']);
	});

	it('takes files dropped on it, and leaves a drag that carries none to whatever else wants it', async () => {
		const { rows } = await setup();
		const files = [new File(['a'], 'one.txt'), new File(['b'], 'two.csv')];
		expect(
			fireEvent.dragOver(region(), { dataTransfer: { types: ['Files'], dropEffect: 'none' } })
		).toBe(false);
		expect(
			fireEvent.drop(region(), {
				dataTransfer: { types: ['Files'], files, getData: () => '' },
			})
		).toBe(false);
		await waitFor(async () => {
			expect(await rows()).toHaveLength(2);
		});

		// A note dragged in the sidebar carries its path as text, never files.
		const note = { types: ['text/plain'], files: [], getData: () => 'Work/plan.md' };
		expect(fireEvent.dragOver(region(), { dataTransfer: note })).toBe(true);
		expect(fireEvent.drop(region(), { dataTransfer: note })).toBe(true);
		expect(await rows()).toHaveLength(2);
	});

	it('says where files dragged over the window can go, and glows brighter with them over it', async () => {
		await setup();
		const files = { types: ['Files'] };
		const hint = () => within(region()).queryByText('Drop here to add to clipboard');
		expect(hint()).toBeNull();

		fireEvent.dragEnter(document.body, { dataTransfer: files });
		expect(hint()).not.toBeNull();
		expect(region().className).toContain('clipboard-drop-ready');
		expect(region().className).not.toContain('clipboard-drop-over');

		fireEvent.dragEnter(region(), { dataTransfer: files });
		expect(region().className).toContain('clipboard-drop-over');
		// From the panel onto an item in it: entered before it is left.
		fireEvent.dragEnter(screen.getByRole('button', { name: 'Paste' }), { dataTransfer: files });
		fireEvent.dragLeave(region(), { dataTransfer: files });
		expect(region().className).toContain('clipboard-drop-over');
		fireEvent.dragLeave(screen.getByRole('button', { name: 'Paste' }), { dataTransfer: files });
		expect(region().className).not.toContain('clipboard-drop-over');
		expect(region().className).toContain('clipboard-drop-ready');

		fireEvent.drop(document.body, { dataTransfer: files });
		expect(hint()).toBeNull();
		expect(region().className).not.toContain('clipboard-drop-ready');
	});

	it('says nothing of a drag that carries no files, and lets go of one that has gone quiet', async () => {
		await setup();
		fireEvent.dragEnter(document.body, { dataTransfer: { types: ['text/plain'] } });
		expect(region().className).not.toContain('clipboard-drop-ready');

		// Let go of where nothing takes it: no drop, and no leave that evens the count.
		fireEvent.dragEnter(document.body, { dataTransfer: { types: ['Files'] } });
		fireEvent.dragEnter(region(), { dataTransfer: { types: ['Files'] } });
		expect(region().className).toContain('clipboard-drop-ready');
		await waitFor(
			() => {
				expect(region().className).not.toContain('clipboard-drop-ready');
			},
			{ timeout: DRAG_GONE_MS * 3 }
		);
	});

	it('takes the files Add a file picks', async () => {
		const { pick, rows } = await setup();
		pick.mockResolvedValueOnce([new File(['x'], 'notes.zip')]);
		await userEvent.setup().click(screen.getByRole('button', { name: 'Add a file' }));

		expect(await screen.findByText('notes.zip')).toBeDefined();
		expect(await rows()).toHaveLength(1);
	});

	it('refuses a file larger than the clipboard takes, by its size, and keeps the rest', async () => {
		const { pick, rows } = await setup();
		const large = new File(['x'], 'film.mov');
		Object.defineProperty(large, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
		const arrayBuffer = vi.spyOn(large, 'arrayBuffer');
		pick.mockResolvedValueOnce([large, new File(['y'], 'small.txt')]);
		await userEvent.setup().click(screen.getByRole('button', { name: 'Add a file' }));

		await waitFor(() => {
			expect(said().textContent).toBe(
				'film.mov is larger than 25 MB, the most the clipboard takes.'
			);
		});
		expect(await screen.findByText('small.txt')).toBeDefined();
		expect(await rows()).toHaveLength(1);
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it('lists the newest first, and puts text back on the clipboard when pressed', async () => {
		const { db, written } = await setup();
		await seeded(db, [{ kind: 'text', text: 'first' }]);
		await seeded(db, [{ kind: 'text', text: 'second' }]);
		await waitFor(() => {
			expect(items().map((item) => item.textContent)).toEqual([
				expect.stringContaining('second'),
				expect.stringContaining('first'),
			]);
		});

		await userEvent
			.setup()
			.click(within(items()[1] ?? region()).getByRole('button', { name: /^Copy text/ }));
		await waitFor(() => {
			expect(said().textContent).toBe('Copied.');
		});
		// Shown over the item it is about, and said, not shown, under the list.
		expect(items()[1]?.querySelector('.clipboard-done')?.textContent).toBe('Copied');
		expect(items()[0]?.querySelector('.clipboard-done')).toBeNull();
		expect(said().className).toContain('clipboard-said-quiet');
		expect(written.map((entry) => entry.type)).toEqual(['text/plain']);
		expect(await written[0]?.blob.text()).toBe('first');
	});

	it('shows a picture as a thumbnail, and copies it as a PNG', async () => {
		const { db, written } = await setup();
		const [name] = await seeded(db, [
			{ kind: 'file', name: '', type: 'image/png', bytes: encode('png'), pasted: true },
		]);

		const button = await screen.findByRole('button', { name: 'Copy Image, waiting to send' });
		await waitFor(() => {
			expect(button.querySelector('img')?.getAttribute('src')).toBe(`blob:${name ?? ''}`);
		});
		await userEvent.setup().click(button);
		await waitFor(() => {
			expect(written.map((entry) => entry.type)).toEqual(['image/png']);
		});
	});

	it('saves a file when pressed, under the name it was added as', async () => {
		const { db, saved } = await setup();
		await seeded(db, [
			{ kind: 'file', name: 'Q3 report.pdf', type: '', bytes: encode('%PDF') },
		]);

		await userEvent
			.setup()
			.click(
				await screen.findByRole('button', { name: 'Save q3-report.pdf, waiting to send' })
			);
		await waitFor(() => {
			expect(said().textContent).toBe('Saved.');
		});
		expect(items()[0]?.querySelector('.clipboard-done')?.textContent).toBe('Saved');
		expect(saved.map((entry) => entry.name)).toEqual(['q3-report.pdf']);
		expect(await saved[0]?.file.text()).toBe('%PDF');
	});

	it('says so when an item is not on this device and cannot be fetched', async () => {
		const { db, sync } = await setup();
		await seeded(db, [{ kind: 'file', name: 'a.pdf', type: '', bytes: encode('%PDF') }]);
		sync.clipboard.read.mockResolvedValueOnce({ state: 'offline' });

		await userEvent.setup().click(await screen.findByRole('button', { name: /^Save a\.pdf/ }));
		await waitFor(() => {
			expect(said().textContent).toBe(
				'That is not on this device, and this device is offline.'
			);
		});
		// Too long to sit over an item, and shown under the list.
		expect(said().className).not.toContain('clipboard-said-quiet');
		expect(items()[0]?.querySelector('.clipboard-done')).toBeNull();
	});

	it('removes an item, and asks for that to be sent', async () => {
		const { db, sync, rows } = await setup();
		await seeded(db, [{ kind: 'text', text: 'gone soon' }]);
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove text' }));

		await waitFor(() => {
			expect(items()).toEqual([]);
		});
		expect(await rows()).toEqual([]);
		expect(sync.clipboard.flush).toHaveBeenCalledWith('c1');
	});
});
