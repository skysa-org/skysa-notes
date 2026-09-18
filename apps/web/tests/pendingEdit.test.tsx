import { EditorView } from '@codemirror/view';
import { type RemoteEntry } from '@skysa/core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db, type NoteRecord } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { deleteNote, getNote, saveNoteBody } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { createDexieSyncStore } from '../src/sync/store.js';
import { updateNote } from './noteRows.js';

/**
 * An edit still in the autosave window when a sync lands on its note.
 *
 * The row is clean until the save arrives, so the store is free to replace its
 * body or delete it, and nothing in the database says there is an edit on the
 * way. Whatever the order, neither the edit nor what the sync brought may be
 * lost (CLAUDE.md, docs/PLAN.md §7).
 */

const CONNECTION = 'dropbox-1';

const remote = (path: string, version: string): RemoteEntry => ({
	remoteId: 'r1',
	path,
	kind: 'file',
	version,
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

const bound = async () => {
	await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
	return createDexieSyncStore(db, { connectionId: CONNECTION });
};

/** A synced, clean note, open in raw mode. */
const synced = async (content = 'before\n') => {
	const store = await bound();
	await store.applyPull({
		changes: [
			{
				kind: 'upsert-note',
				id: 'n1',
				path: 'a.md',
				content,
				remote: remote('a.md', 'v1'),
				syncedHash: 'hash',
			},
		],
	});
	// Raw by default too: a note written again from a file forgets its mode.
	await setDefaultEditorMode(db, 'raw');
	return store;
};

const pulled = (content: string, version = 'v2') =>
	({
		kind: 'upsert-note',
		id: 'n1',
		path: 'a.md',
		content,
		remote: remote('a.md', version),
		syncedHash: 'hash',
	}) as const;

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

const open = async () => {
	const { container } = render(<Harness id="n1" />);
	await waitFor(() => {
		expect(EditorView.findFromDOM(container)).not.toBeNull();
	});
	const view = () => {
		const found = EditorView.findFromDOM(container);
		if (found === null) throw new Error('CodeMirror is not mounted');
		return found;
	};
	return {
		view,
		type: (text: string) => {
			act(() => {
				const editor = view();
				editor.dispatch({
					changes: { from: editor.state.doc.length, insert: text },
					userEvent: 'input.type',
				});
			});
		},
	};
};

/** What `pagehide` does: the pending save goes now, rather than in two seconds. */
const flushAutosave = () => {
	act(() => {
		window.dispatchEvent(new Event('pagehide'));
	});
};

const notes = () => db.notes.where('connectionId').equals(CONNECTION).toArray();
const writesFor = async (id: string) =>
	(await db.opQueue.where('noteId').equals(id).toArray()).filter((op) => op.op === 'write');

const copyOf = async (): Promise<NoteRecord | undefined> =>
	(await notes()).find((note) => note.id !== 'n1');

afterEach(async () => {
	cleanup();
	await Promise.all([
		db.notes.clear(),
		db.opQueue.clear(),
		db.syncState.clear(),
		db.folders.clear(),
		db.prefs.clear(),
	]);
});

describe('an edit pending when a pull replaces its note', () => {
	it('is kept as a conflict copy, and the note keeps what was pulled', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		await store.applyPull({ changes: [pulled('theirs\n')] });
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('theirs\n');
		});
		flushAutosave();

		await waitFor(async () => {
			// The file had no frontmatter, and gains a block with the customary
			// blank line after it.
			expect((await copyOf())?.body).toBe('\nbefore\nmine\n');
		});
		const copy = await copyOf();
		expect(copy?.path).toMatch(/^a \(conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}\)\.md$/);
		expect(copy?.dirty).toBe(1);
		expect(copy?.source).toContain(`id: ${copy?.id ?? ''}`);
		expect(await writesFor(copy?.id ?? '')).toHaveLength(1);

		const note = await getNote(db, 'n1');
		expect(note?.body).toBe('theirs\n');
		expect(note?.dirty).toBe(0);
		expect(await writesFor('n1')).toEqual([]);
	});

	it('is saved on its own before an edit typed into what was pulled', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		await store.applyPull({ changes: [pulled('theirs\n')] });
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('theirs\n');
		});
		// Typed after the pull: this one stands for nothing before it.
		editor.type('and more\n');
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('theirs\nand more\n');
		});
		await waitFor(async () => {
			// The file had no frontmatter, and gains a block with the customary
			// blank line after it.
			expect((await copyOf())?.body).toBe('\nbefore\nmine\n');
		});
		expect((await getNote(db, 'n1'))?.dirty).toBe(1);
		expect(await notes()).toHaveLength(2);
	});

	it('is saved as usual when the pull changed only the frontmatter', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		await store.applyPull({ changes: [pulled('---\ntags: [work]\n---\nbefore\n')] });
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.tags).toEqual(['work']);
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\nmine\n');
		});
		expect((await getNote(db, 'n1'))?.tags).toEqual(['work']);
		expect(await notes()).toHaveLength(1);
	});

	it('is saved as usual when its own push completes meanwhile', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('one\n');
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.dirty).toBe(1);
		});
		editor.type('two\n');
		await store.applyPull({
			changes: [{ kind: 'adopt-version', id: 'n1', remote: remote('a.md', 'v2') }],
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\none\ntwo\n');
		});
		expect(await notes()).toHaveLength(1);
	});
});

describe('an edit pending when a pull deletes its note', () => {
	it('brings the note back holding the edit, owed to the remote as a new file', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		await store.applyPull({ changes: [{ kind: 'delete-note', id: 'n1' }] });

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\nmine\n');
		});
		const note = await getNote(db, 'n1');
		expect(note?.dirty).toBe(1);
		expect(note?.deletedLocally).toBe(0);
		expect(note?.path).toBe('a.md');
		expect(note?.remoteId).toBeUndefined();
		expect(note?.remoteVersion).toBeUndefined();
		expect(note?.syncedHash).toBeUndefined();
		expect(await writesFor('n1')).toHaveLength(1);
		// And open again, with the words in it.
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('before\nmine\n');
		});
	});
});

describe('an edit pending when pulls land in ways that repeat themselves', () => {
	it('is not written over a note deleted and written again in one batch', async () => {
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		// A file deleted and made again at the same id: the row is new, and must
		// not look like the one the edit was typed into.
		await store.applyPull({ changes: [{ kind: 'delete-note', id: 'n1' }, pulled('theirs\n')] });
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('theirs\n');
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await copyOf())?.body).toBe('\nbefore\nmine\n');
		});
		expect((await getNote(db, 'n1'))?.body).toBe('theirs\n');
		expect((await getNote(db, 'n1'))?.dirty).toBe(0);
	});

	it('shows a remote revert to text the editor wrote, and saves edits into it', async () => {
		const store = await synced();
		const editor = await open();

		// Typed and taken back, so the editor has written 'before\n' itself.
		editor.type('x');
		act(() => {
			const view = editor.view();
			view.dispatch({
				changes: { from: view.state.doc.length - 1, to: view.state.doc.length },
				userEvent: 'delete.backward',
			});
		});
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.dirty).toBe(1);
		});
		// Pushed, then changed elsewhere, then changed back.
		await updateNote(db, 'n1', { dirty: 0 });
		await db.opQueue.clear();
		await store.applyPull({ changes: [pulled('theirs\n', 'v2')] });
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('theirs\n');
		});
		await store.applyPull({ changes: [pulled('before\n', 'v3')] });

		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('before\n');
		});
		editor.type('1');
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\n1');
		});
		expect(await notes()).toHaveLength(1);
	});

	it('is saved as usual when a note written here without frontmatter gains a tag elsewhere', async () => {
		// The first save gives the file a block and a blank line after it, which
		// reads back as the start of the body. The body is the same.
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.dirty).toBe(1);
		});
		const saved = await getNote(db, 'n1');
		const pushed = saved?.source ?? '';
		expect(pushed).toMatch(/^---\n[\s\S]*\n---\n\nbefore\nmine\n$/);
		await updateNote(db, 'n1', { dirty: 0 });
		await db.opQueue.clear();

		editor.type('more\n');
		await store.applyPull({
			changes: [pulled(pushed.replace(/\n---\n/, '\ntags:\n  - work\n---\n'), 'v3')],
		});
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.tags).toEqual(['work']);
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\nmine\nmore\n');
		});
		expect(await notes()).toHaveLength(1);
		// And the editor still shows it: nothing was taken in over the edit.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(editor.view().state.doc.toString()).toBe('before\nmine\nmore\n');
	});

	it('is saved as usual when that note gains a second tag elsewhere', async () => {
		// After the first tag the row holds the file with its blank line, and
		// every later pull reads the body from the file the same way.
		const store = await synced();
		const editor = await open();

		editor.type('mine\n');
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.dirty).toBe(1);
		});
		const pushed = (await getNote(db, 'n1'))?.source ?? '';
		await updateNote(db, 'n1', { dirty: 0 });
		await db.opQueue.clear();
		const tagged = (tags: string) => pushed.replace(/\n---\n/, `\ntags:\n${tags}---\n`);
		await store.applyPull({ changes: [pulled(tagged('  - work\n'), 'v3')] });
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.tags).toEqual(['work']);
		});

		editor.type('more\n');
		await store.applyPull({ changes: [pulled(tagged('  - work\n  - home\n'), 'v4')] });
		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.tags).toEqual(['work', 'home']);
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, 'n1'))?.body).toBe('before\nmine\nmore\n');
		});
		expect(await notes()).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(editor.view().state.doc.toString()).toBe('before\nmine\nmore\n');
	});

	it('is copied under the title its own heading gives it', async () => {
		const store = await synced('# Before\n');
		const editor = await open();

		act(() => {
			const view = editor.view();
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: '# Mine\n' },
				userEvent: 'input.type',
			});
		});
		await store.applyPull({ changes: [pulled('# Theirs\n')] });
		await waitFor(() => {
			expect(editor.view().state.doc.toString()).toBe('# Theirs\n');
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await copyOf())?.title).toBe('Mine');
		});
		expect((await getNote(db, 'n1'))?.title).toBe('Theirs');
	});
});

describe('saveNoteBody with a base', () => {
	const shown = async () => {
		const note = await getNote(db, 'n1');
		if (note === undefined) throw new Error('no note');
		return note;
	};
	const originOf = async () => (await shown()).bodyOrigin ?? '';

	it('writes nothing new when the body it would copy is the one pulled', async () => {
		const store = await synced();
		const note = await shown();
		const origin = await originOf();
		await store.applyPull({ changes: [pulled('same\n')] });

		await saveNoteBody(db, 'n1', 'same\n', { origin, note });

		expect(await notes()).toHaveLength(1);
		expect((await getNote(db, 'n1'))?.dirty).toBe(0);
	});

	it('brings a note back under a conflict name when a pulled file has its path', async () => {
		const store = await synced();
		const note = await shown();
		const origin = await originOf();
		await store.applyPull({
			changes: [
				{ kind: 'delete-note', id: 'n1' },
				{
					kind: 'upsert-note',
					id: 'n2',
					path: 'a.md',
					content: 'another\n',
					remote: { ...remote('a.md', 'v1'), remoteId: 'r2' },
					syncedHash: 'hash',
				},
			],
		});

		const back = await saveNoteBody(db, 'n1', 'mine\n', { origin, note });

		expect(back.id).toBe('n1');
		expect(back.path).toMatch(/^a \(conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}\)\.md$/);
		expect((await getNote(db, 'n2'))?.body).toBe('another\n');
	});

	it('keeps making edits against a note it brought back', async () => {
		const store = await synced();
		await store.applyPull({ changes: [pulled('theirs\n')] });
		const note = await shown();
		const origin = await originOf();
		await store.applyPull({ changes: [{ kind: 'delete-note', id: 'n1' }] });

		// Shown as it was before the pull the editor has since adopted.
		await saveNoteBody(db, 'n1', 'mine\n', { origin, note: { ...note, bodyOrigin: 'older' } });
		await saveNoteBody(db, 'n1', 'mine, more\n', { origin, note });

		expect((await getNote(db, 'n1'))?.body).toBe('mine, more\n');
		expect(await notes()).toHaveLength(1);
	});

	it('writes into a note deleted here even after a pull replaced it', async () => {
		// Kept deleted, as a conflict on its way out is (§7): a copy would be a
		// new live note holding text the user deleted.
		const store = await synced();
		const note = await shown();
		const origin = await originOf();
		await deleteNote(db, 'n1');
		await store.applyPull({ changes: [pulled('theirs\n')] });

		await saveNoteBody(db, 'n1', 'mine\n', { origin, note });

		expect((await getNote(db, 'n1'))?.deletedLocally).toBe(1);
		expect(await notes()).toHaveLength(1);
	});

	it('writes into a note deleted here, which stays deleted', async () => {
		await synced();
		const note = await shown();
		const origin = await originOf();
		await deleteNote(db, 'n1');

		await saveNoteBody(db, 'n1', 'mine\n', { origin, note });

		expect((await getNote(db, 'n1'))?.body).toBe('mine\n');
		expect((await getNote(db, 'n1'))?.deletedLocally).toBe(1);
		expect(await notes()).toHaveLength(1);
	});

	it('gives a body from outside a new origin, and nothing else one', async () => {
		const store = await synced();
		const first = await originOf();
		expect(first).not.toBe('');

		await store.applyPull({ changes: [pulled('---\ntags: [x]\n---\nbefore\n')] });
		expect(await originOf()).toBe(first);

		await store.applyPull({ changes: [pulled('after\n', 'v3')] });
		const second = await originOf();
		expect(second).not.toBe(first);

		await saveNoteBody(db, 'n1', 'edited\n');
		expect(await originOf()).toBe(second);
	});
});
