import { parseNoteFile, splitFrontmatter } from '@skysa/core';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { listFolders } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	getNote,
	importNoteFile,
	listDirtyNotes,
	listNotes,
	moveNote,
	noteFileContents,
	purgeNote,
	renameNote,
	restoreNote,
	saveNoteBody,
	setNoteEditorMode,
	setNoteTags,
} from '../src/store/notes.js';

let db: NotesDatabase;
let counter = 0;

beforeEach(() => {
	counter += 1;
	db = createDatabase(`test-notes-${counter}`);
});

afterEach(async () => {
	await db.delete();
});

describe('createNote', () => {
	it('creates a note at the root with a slugged filename', async () => {
		const note = await createNote(db, { title: '2026 Q3 Planning' });
		expect(note.path).toBe('2026-q3-planning.md');
		expect(note.title).toBe('2026 Q3 Planning');
	});

	it('starts dirty, because creating a note is a user action', async () => {
		const note = await createNote(db, { title: 'Hi' });
		expect(note.dirty).toBe(1);
	});

	it('writes id, title and timestamps into frontmatter', async () => {
		const note = await createNote(db, { title: 'Hi' });
		const parsed = parseNoteFile(noteFileContents(note));
		expect(parsed.id).toBe(note.id);
		expect(parsed.title).toBe('Hi');
		expect(parsed.created).toBeDefined();
	});

	it('disambiguates a colliding filename in the same folder', async () => {
		await createNote(db, { title: 'Notes' });
		const second = await createNote(db, { title: 'Notes' });
		expect(second.path).toBe('notes-2.md');
	});

	it('allows the same name in a different folder', async () => {
		await createNote(db, { title: 'Notes' });
		const other = await createNote(db, { title: 'Notes', folderPath: 'work' });
		expect(other.path).toBe('work/notes.md');
	});

	it('creates the containing folder', async () => {
		await createNote(db, { title: 'Standup', folderPath: 'work/meetings' });
		expect((await listFolders(db)).map((f) => f.path)).toEqual(['work', 'work/meetings']);
	});

	it('takes its title from the body when none is given', async () => {
		const note = await createNote(db, { body: '# Derived Title\n\nText.\n' });
		expect(note.title).toBe('Derived Title');
		expect(note.path).toBe('derived-title.md');
	});

	it('does not pin "Untitled" into frontmatter, which would block auto-naming', async () => {
		const note = await createNote(db);
		expect(note.path).toBe('untitled.md');
		expect(noteFileContents(note)).not.toContain('title:');
	});
});

describe('saveNoteBody', () => {
	it('records the edit and marks the note dirty', async () => {
		const note = await importNoteFile(db, { path: 'a.md', source: '# A\n' });
		expect(note.dirty).toBe(0);

		const edited = await saveNoteBody(db, note.id, '# A\n\nMore.\n');
		expect(edited.body).toBe('# A\n\nMore.\n');
		expect(edited.dirty).toBe(1);
	});

	it('changes the content hash', async () => {
		const note = await createNote(db, { title: 'Hi', body: 'one\n' });
		const edited = await saveNoteBody(db, note.id, 'two\n');
		expect(edited.contentHash).not.toBe(note.contentHash);
	});

	it('follows the body heading when frontmatter has no title', async () => {
		const note = await importNoteFile(db, { path: 'a.md', source: '# Old\n' });
		const edited = await saveNoteBody(db, note.id, '# New\n');
		expect(edited.title).toBe('New');
	});

	it('keeps an explicit frontmatter title even when the heading changes', async () => {
		const note = await importNoteFile(db, {
			path: 'a.md',
			source: '---\ntitle: Pinned\n---\n\n# Old\n',
		});
		const edited = await saveNoteBody(db, note.id, '# New\n');
		expect(edited.title).toBe('Pinned');
	});

	it('rejects an unknown id', async () => {
		await expect(saveNoteBody(db, 'nope', 'x')).rejects.toThrow(/No note with id/);
	});
});

describe('naming an untitled note by its first heading', () => {
	it('renames the file once the user types a heading', async () => {
		const note = await createNote(db);
		expect(note.path).toBe('untitled.md');

		const named = await saveNoteBody(db, note.id, '# Q3 Planning\n\nBody.\n');
		expect(named.title).toBe('Q3 Planning');
		expect(named.path).toBe('q3-planning.md');
	});

	it('keeps it untitled while there is no heading to take', async () => {
		const note = await createNote(db);
		const edited = await saveNoteBody(db, note.id, 'Just prose, no heading.\n');

		expect(edited.title).toBe('Untitled');
		expect(edited.path).toBe('untitled.md');
	});

	it('names it inside its own folder', async () => {
		const note = await createNote(db, { folderPath: 'work' });
		const named = await saveNoteBody(db, note.id, '# Standup\n');
		expect(named.path).toBe('work/standup.md');
	});

	it('avoids colliding with a note already named that', async () => {
		await createNote(db, { title: 'Taken' });
		const note = await createNote(db);
		expect((await saveNoteBody(db, note.id, '# Taken\n')).path).toBe('taken-2.md');
	});

	it('stops following the heading once the note has a name', async () => {
		const note = await createNote(db);
		await saveNoteBody(db, note.id, '# First Name\n');
		const again = await saveNoteBody(db, note.id, '# Second Name\n');

		// The title follows, because nothing pinned it...
		expect(again.title).toBe('Second Name');
		// ...but the file is not renamed a second time.
		expect(again.path).toBe('first-name.md');
	});

	it('never renames a note imported from another tool', async () => {
		const note = await importNoteFile(db, { path: 'their-file.md', source: '# Old\n' });
		const edited = await saveNoteBody(db, note.id, '# New Heading\n');

		expect(edited.title).toBe('New Heading');
		expect(edited.path).toBe('their-file.md');
	});

	it('leaves a note created with an explicit title alone', async () => {
		const note = await createNote(db, { title: 'Chosen' });
		const edited = await saveNoteBody(db, note.id, '# Something Else\n');

		expect(edited.title).toBe('Chosen');
		expect(edited.path).toBe('chosen.md');
	});
});

describe('renameNote', () => {
	it('moves the file and updates frontmatter, keeping the id', async () => {
		const note = await createNote(db, { title: 'Old Name' });
		const renamed = await renameNote(db, note.id, 'New Name');

		expect(renamed.id).toBe(note.id);
		expect(renamed.path).toBe('new-name.md');
		expect(parseNoteFile(noteFileContents(renamed)).title).toBe('New Name');
	});

	it('avoids colliding with a sibling', async () => {
		await createNote(db, { title: 'Taken' });
		const note = await createNote(db, { title: 'Other' });
		expect((await renameNote(db, note.id, 'Taken')).path).toBe('taken-2.md');
	});

	it('does not collide with itself', async () => {
		const note = await createNote(db, { title: 'Same' });
		expect((await renameNote(db, note.id, 'Same')).path).toBe('same.md');
	});
});

describe('moveNote', () => {
	it('moves the note into another folder, keeping its filename', async () => {
		const note = await createNote(db, { title: 'Reading List' });
		const moved = await moveNote(db, note.id, 'personal');
		expect(moved.path).toBe('personal/reading-list.md');
	});

	it('creates the destination folder', async () => {
		const note = await createNote(db, { title: 'A' });
		await moveNote(db, note.id, 'deep/nested');
		expect((await listFolders(db)).map((f) => f.path)).toContain('deep/nested');
	});

	it('disambiguates against a note already there', async () => {
		await createNote(db, { title: 'Same', folderPath: 'work' });
		const note = await createNote(db, { title: 'Same' });
		expect((await moveNote(db, note.id, 'work')).path).toBe('work/same-2.md');
	});

	it('moves a note back to the root', async () => {
		const note = await createNote(db, { title: 'A', folderPath: 'work' });
		expect((await moveNote(db, note.id, '')).path).toBe('a.md');
	});
});

describe('listNotes', () => {
	it('lists only live notes, newest edit first', async () => {
		const first = await createNote(db, { title: 'First' });
		const second = await createNote(db, { title: 'Second' });
		await deleteNote(db, first.id);

		expect((await listNotes(db)).map((n) => n.id)).toEqual([second.id]);
	});

	it('can be restricted to one folder', async () => {
		await createNote(db, { title: 'Root note' });
		const inner = await createNote(db, { title: 'Work note', folderPath: 'work' });

		expect((await listNotes(db, { folderPath: 'work' })).map((n) => n.id)).toEqual([inner.id]);
	});

	it('does not treat a nested note as a child of the root', async () => {
		await createNote(db, { title: 'Nested', folderPath: 'work' });
		expect(await listNotes(db, { folderPath: '' })).toEqual([]);
	});

	it('can include tombstones, which sync needs and the UI does not', async () => {
		const note = await createNote(db, { title: 'Gone' });
		await deleteNote(db, note.id);

		expect(await listNotes(db)).toEqual([]);
		expect((await listNotes(db, { includeDeleted: true })).map((n) => n.id)).toEqual([note.id]);
	});
});

describe('deleting', () => {
	it('tombstones rather than removing, so the delete can be pushed', async () => {
		const note = await createNote(db, { title: 'Gone' });
		await deleteNote(db, note.id);

		const stored = await getNote(db, note.id);
		expect(stored?.deletedLocally).toBe(1);
		expect(stored?.dirty).toBe(1);
	});

	it('restores a tombstoned note', async () => {
		const note = await createNote(db, { title: 'Back' });
		await deleteNote(db, note.id);
		await restoreNote(db, note.id);

		expect((await getNote(db, note.id))?.deletedLocally).toBe(0);
	});

	it('purges for good once the provider has confirmed', async () => {
		const note = await createNote(db, { title: 'Gone' });
		await deleteNote(db, note.id);
		await purgeNote(db, note.id);

		expect(await getNote(db, note.id)).toBeUndefined();
	});
});

describe('setNoteTags', () => {
	it('writes tags to frontmatter and normalizes them', async () => {
		const note = await createNote(db, { title: 'Tagged' });
		const tagged = await setNoteTags(db, note.id, ['Planning', 'Deep Work']);

		expect(tagged.tags).toEqual(['planning', 'deep-work']);
		expect(parseNoteFile(noteFileContents(tagged)).tags).toEqual(['planning', 'deep-work']);
	});

	it('drops duplicates and blanks', async () => {
		const note = await createNote(db, { title: 'Tagged' });
		expect((await setNoteTags(db, note.id, ['a', 'A', '', '  ', '***'])).tags).toEqual(['a']);
	});

	it('does not turn an empty tag into the filename fallback', async () => {
		const note = await createNote(db, { title: 'Tagged' });
		expect((await setNoteTags(db, note.id, [''])).tags).toEqual([]);
		// ...but a tag actually called "untitled" is a real tag.
		expect((await setNoteTags(db, note.id, ['untitled'])).tags).toEqual(['untitled']);
	});
});

describe('importNoteFile — the rule that a note is dirty only on a real edit', () => {
	it('never marks an imported note dirty', async () => {
		const note = await importNoteFile(db, { path: 'a.md', source: '# A\n' });
		expect(note.dirty).toBe(0);
	});

	it('does not reformat a file written by another tool', async () => {
		const source = '---\naliases: [x]\nobsidian_banner: cover.png\n---\n\n* one\n* two\n';
		const note = await importNoteFile(db, { path: 'a.md', source });

		// Body kept verbatim: `*` bullets are not rewritten to `-` on load.
		expect(note.body).toBe('\n* one\n* two\n');
		expect(note.frontmatter).toBe(splitFrontmatter(source).frontmatter);
	});

	/**
	 * `Date.parse` answers `NaN` for anything it cannot read, and these fields
	 * come out of a file the app did not write. An unterminated quote swallows
	 * the following line into the value, which is exactly the shape the YAML
	 * parser recovers from and hands back.
	 *
	 * `NaN` is worse than a wrong date: `updatedAt` is an index and the note
	 * list sorts on it, and a comparator that is false in both directions
	 * leaves the whole list in no particular order, not just that one note.
	 */
	it('falls back to now when a frontmatter date cannot be read', async () => {
		const note = await importNoteFile(db, {
			path: 'a.md',
			source: '---\nid: abc\nupdated: "2026-09-15T00:00:00Z\ntitle: A\n---\n\n# A\n',
		});

		expect(Number.isNaN(note.updatedAt)).toBe(false);
		expect(Number.isNaN(note.createdAt)).toBe(false);
		expect(() => noteFileContents(note)).not.toThrow();
	});

	it('re-importing an unchanged file leaves it clean', async () => {
		const source = '---\nid: 018f3c4e\n---\n\n# A\n';
		await importNoteFile(db, { path: 'a.md', source });
		const again = await importNoteFile(db, { path: 'a.md', source });

		expect(again.dirty).toBe(0);
		expect(await listNotes(db)).toHaveLength(1);
	});

	it('adopts the frontmatter id as the local id, so moves re-link', async () => {
		const source = '---\nid: 018f3c4e-0000-7000-8000-000000000000\n---\n\n# A\n';
		const first = await importNoteFile(db, { path: 'a.md', source });
		const moved = await importNoteFile(db, { path: 'work/a.md', source });

		expect(moved.id).toBe(first.id);
		expect(moved.path).toBe('work/a.md');
		expect(await listNotes(db)).toHaveLength(1);
	});

	it('matches on path when the file carries no id', async () => {
		await importNoteFile(db, { path: 'a.md', source: '# A\n' });
		await importNoteFile(db, { path: 'a.md', source: '# A changed\n' });

		const notes = await listNotes(db);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.title).toBe('A changed');
	});

	it('records the remote id and version when given them', async () => {
		const note = await importNoteFile(db, {
			path: 'a.md',
			source: '# A\n',
			remoteId: 'id:abc',
			remoteVersion: 'rev1',
		});
		expect(note.remoteId).toBe('id:abc');
		expect(note.remoteVersion).toBe('rev1');
	});

	it('takes its title from the filename when the file has neither', async () => {
		const note = await importNoteFile(db, { path: 'work/quick-thought.md', source: 'Text.\n' });
		expect(note.title).toBe('quick thought');
	});
});

describe('listDirtyNotes', () => {
	it('returns only notes with unpushed edits, oldest first', async () => {
		const clean = await importNoteFile(db, { path: 'clean.md', source: '# Clean\n' });
		const edited = await createNote(db, { title: 'Edited' });

		const dirty = await listDirtyNotes(db);
		expect(dirty.map((n) => n.id)).toEqual([edited.id]);
		expect(dirty.map((n) => n.id)).not.toContain(clean.id);
	});
});

describe('noteFileContents', () => {
	it('round-trips through the markdown pipeline', async () => {
		const note = await createNote(db, { title: 'Round Trip', body: '# Round Trip\n\nBody.\n' });
		const parsed = parseNoteFile(noteFileContents(note));

		expect(parsed.id).toBe(note.id);
		expect(parsed.title).toBe('Round Trip');
		expect(parsed.body.trim()).toBe('# Round Trip\n\nBody.');
	});

	it('preserves frontmatter keys the app does not know about', async () => {
		const note = await importNoteFile(db, {
			path: 'a.md',
			source: '---\nobsidian_banner: cover.png\n---\n\n# A\n',
		});
		const edited = await saveNoteBody(db, note.id, '# A edited\n');

		expect(noteFileContents(edited)).toContain('obsidian_banner: cover.png');
	});

	it('creates a folder note with no frontmatter when there is nothing to write', async () => {
		const note = await importNoteFile(db, { path: 'a.md', source: '# A\n' });
		expect(note.frontmatter).toBeNull();
		// Serializing adds the block, because the app now has an id and title for it.
		expect(noteFileContents(note)).toMatch(/^---\n/);
	});
});

describe('setNoteEditorMode', () => {
	it('remembers the mode without touching the note', async () => {
		const note = await importNoteFile(db, { path: 'a.md', source: '# A\n' });

		await setNoteEditorMode(db, note.id, 'raw');

		const stored = await db.notes.get(note.id);
		expect(stored?.editorMode).toBe('raw');
		// Which editor a note is shown in says nothing about the file, so it must
		// not queue a write to the provider.
		expect(stored?.dirty).toBe(0);
		expect(stored?.updatedAt).toBe(note.updatedAt);
		expect(stored?.contentHash).toBe(note.contentHash);
	});
});

/**
 * `applyEdit` reads the note, computes a hash, then writes the whole record
 * back. `contentHash` is `crypto.subtle.digest`, which is genuinely async, so
 * without a transaction around all three steps any write that lands in that
 * window is overwritten wholesale — and the app deliberately puts writes next
 * to each other: `NoteView` flushes a pending autosave immediately before
 * renaming, deleting, or switching mode.
 *
 * The competing write is fired from inside the stubbed digest, which is the
 * only way to place it in that window exactly. Starting it alongside and
 * hoping is not a test: it lands before the read on any machine fast enough,
 * and then passes while proving nothing.
 */
describe('an edit that overlaps another write to the same note', () => {
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	afterEach(() => {
		crypto.subtle.digest = digest;
	});

	/**
	 * Runs `competing` while the first hash is in flight, and returns a promise
	 * for it. It is started rather than awaited: with the transaction in place
	 * it blocks until the edit commits, so awaiting it here would deadlock the
	 * test rather than exercise the code.
	 */
	const during = (competing: () => Promise<unknown>): Promise<unknown> => {
		let started: (value: Promise<unknown>) => void = () => undefined;
		const ran = new Promise<unknown>((resolve) => {
			started = resolve;
		});
		let seen = 0;
		crypto.subtle.digest = async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
			seen += 1;
			if (seen === 1) {
				// Outside the running transaction's zone. Dexie adopts any db
				// call made inside it into that same transaction, which would
				// make the competing write part of the edit rather than a rival
				// to it — the one arrangement where nothing can go wrong, and so
				// the one arrangement that proves nothing. A real second write
				// comes from an event handler, which is what this is.
				started(Dexie.ignoreTransaction(competing));
				for (let i = 0; i < 20; i += 1)
					await new Promise((resolve) => setTimeout(resolve, 0));
			}
			return digest(algorithm, data);
		};
		return ran;
	};

	it('does not lose the body when a rename lands during the hash', async () => {
		const note = await createNote(db, { folderPath: 'Notebook' });
		const renaming = during(() => renameNote(db, note.id, 'Renamed'));

		await saveNoteBody(db, note.id, 'a paragraph the user typed\n');
		await renaming;

		const after = await getNote(db, note.id);
		expect(after?.body).toBe('a paragraph the user typed\n');
		expect(after?.title).toBe('Renamed');
	});

	it('does not resurrect a note deleted during the hash', async () => {
		const note = await createNote(db, { folderPath: 'Notebook' });
		const deleting = during(() => deleteNote(db, note.id));

		await saveNoteBody(db, note.id, 'typed then deleted\n');
		await deleting;

		expect((await getNote(db, note.id))?.deletedLocally).toBe(1);
	});

	it('does not forget a mode switch made during the hash', async () => {
		const note = await createNote(db, { folderPath: 'Notebook' });
		const switching = during(() => setNoteEditorMode(db, note.id, 'raw'));

		await saveNoteBody(db, note.id, 'typed then switched\n');
		await switching;

		expect((await getNote(db, note.id))?.editorMode).toBe('raw');
	});

	/**
	 * The pull side of sync is the same shape: read the row, hash, write the row
	 * whole. Read outside a transaction, what it writes back is a note that may
	 * no longer be there — and since it writes the id and `createdAt` it read, it
	 * puts a deleted note back under its old identity.
	 *
	 * Which of an import and a local edit wins the *content* is the conflict
	 * question, and is not this; this is only that one of them happens after the
	 * other rather than through the middle of it.
	 */
	it('does not bring a purged note back from a stale read', async () => {
		const note = await createNote(db, { folderPath: 'Notebook' });
		const purging = during(() => purgeNote(db, note.id));

		await importNoteFile(db, { path: note.path, source: '# From the remote\n' });
		await purging;

		expect(await getNote(db, note.id)).toBeUndefined();
	});
});

/**
 * Holding the row for the write is only half of it. An autosave on a note with
 * no name of its own also decides *what to call it* — from the first heading —
 * and that decision has to be made in the same window as the write it informs.
 * Decided beforehand, it is an answer about a note that has since been given a
 * name, and it goes in over the name the user chose.
 *
 * The rename goes first here and the save second, which is the order the app
 * produces: the 2s autosave debounce fires on its own, and the user is still
 * looking at the note when they rename it.
 */
describe('an autosave that decides the note is still unnamed', () => {
	it('does not put the heading back over the name the user chose', async () => {
		const note = await createNote(db, { folderPath: 'Notebook' });

		await Promise.all([
			renameNote(db, note.id, 'User chose this'),
			saveNoteBody(db, note.id, '# A heading\n'),
		]);

		const after = await getNote(db, note.id);
		expect(after?.title).toBe('User chose this');
		expect(after?.path).toBe('Notebook/user-chose-this.md');
		expect(after?.body).toBe('# A heading\n');
	});
});

/**
 * Two clicks on "New note" are one user action as far as the user is concerned,
 * and the button is neither disabled nor debounced. Both pick a filename from
 * the names already taken, and the digest between that read and the insert is
 * long enough for each to see a folder without the other's note in it.
 */
describe('two notes created at once', () => {
	it('do not both take the same filename', async () => {
		const [one, two] = await Promise.all([
			createNote(db, { folderPath: 'Notebook' }),
			createNote(db, { folderPath: 'Notebook' }),
		]);

		expect(one.path).not.toBe(two.path);
		expect(
			(await listNotes(db, { folderPath: 'Notebook' })).map((note) => note.path).sort()
		).toEqual([one.path, two.path].sort());
	});

	it('do not both take the same filename when renamed at once', async () => {
		const one = await createNote(db, { folderPath: 'Notebook', title: 'One' });
		const two = await createNote(db, { folderPath: 'Notebook', title: 'Two' });

		await Promise.all([renameNote(db, one.id, 'Same'), renameNote(db, two.id, 'Same')]);

		const paths = (await listNotes(db, { folderPath: 'Notebook' })).map((note) => note.path);
		expect(new Set(paths).size).toBe(2);
	});
});
