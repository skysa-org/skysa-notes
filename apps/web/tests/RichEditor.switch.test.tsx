import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandsProvider, useShortcuts } from '../src/commands/context.js';
import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import {
	createNote,
	getNote,
	importNoteFile,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';

/**
 * Switching from one note to another, with the real editor.
 *
 * `RichEditor.test.tsx` mocks `rich.js` wholesale, so every claim it makes
 * about the fidelity check is a claim about the mock — and it never changes
 * `noteId` at all. This one does neither: it renders the actual Milkdown
 * editor and moves from one note to the next, which is the most ordinary thing
 * a user does, and is where the check was comparing the outgoing note's
 * document against the incoming note's text.
 */

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

/** The note the view is actually showing, which `useNote` resolves async. */
const showing = async (title: string): Promise<void> => {
	await waitFor(() => {
		const input = screen.getByLabelText('Note title');
		expect((input as HTMLInputElement).value).toBe(title);
	});
	await waitFor(() => {
		expect(document.querySelector('.ProseMirror')?.textContent).not.toBe('');
	});
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
});

describe('moving between two notes in rich mode', () => {
	it('does not call the second note unrepresentable', async () => {
		const first = await createNote(db, { title: 'First', body: 'the first body\n' });
		const second = await createNote(db, { title: 'Second', body: 'a different body\n' });

		const view = render(<Harness id={first.id} />);
		await showing('First');

		view.rerender(<Harness id={second.id} />);
		await showing('Second');

		// The banner is the tell: it says the note contains markdown the editor
		// cannot show — which is false — disables the toggle, and does not clear
		// short of a page reload.
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(screen.getByTestId('rich-editor')).toBeDefined();
		expect(document.querySelector('.ProseMirror')?.textContent).toBe('a different body');
	});

	/**
	 * "A note becomes dirty only on a user editing transaction, never on load,
	 * mode switch, or re-serialization" (CLAUDE.md). Building an editor for a
	 * note is a load, and so is building one for a note that has been loaded
	 * before — the editor parses the markdown and serializes it back, and if
	 * that round trip is taken for an edit the note is queued for a write to the
	 * user's provider that nobody asked for.
	 */
	it('does not touch either note on the way there and back', async () => {
		const first = await importNoteFile(db, {
			path: 'first.md',
			source: '# First\n\nthe first body\n',
		});
		const second = await importNoteFile(db, {
			path: 'second.md',
			source: '# Second\n\na different body\n',
		});

		const view = render(<Harness id={first.id} />);
		await showing('First');
		view.rerender(<Harness id={second.id} />);
		await showing('Second');
		view.rerender(<Harness id={first.id} />);
		await showing('First');

		expect(document.querySelector('.ProseMirror')?.textContent).toContain('the first body');
		for (const note of [first, second]) {
			const after = await getNote(db, note.id);
			expect(after?.dirty).toBe(0);
			expect(after?.body).toBe(note.body);
			expect(after?.updatedAt).toBe(note.updatedAt);
		}
	});
});

/**
 * The fidelity check asks whether this note's markdown survives the editor's
 * document model. It is a question about the note, asked once, before the user
 * can type — so it must not be asked again later against the text the editor was
 * *built* with, which stops describing the document the moment anything changes.
 *
 * `useEditor` hands back a new `get` closure on every render, so an effect that
 * depends on it re-runs on every render — and the app re-renders constantly:
 * every autosave, every rename, every live-query update. The check then finds
 * the document and its stale snapshot disagree and declares the note
 * unrepresentable, which drops it into raw mode and disables the toggle for the
 * session.
 */
describe('a note whose body changes while it is open', () => {
	it('is not declared unrepresentable by the next re-render', async () => {
		const note = await createNote(db, { title: 'Open', body: 'what it started as\n' });
		render(<Harness id={note.id} />);
		await showing('Open');

		// A raw-mode edit or a sync pull: the body changes under the open editor,
		// which adopts it. Nothing here is the user typing into rich text.
		await saveNoteBody(db, note.id, 'what it says now\n');
		await waitFor(() => {
			expect(document.querySelector('.ProseMirror')?.textContent).toBe('what it says now');
		});

		// Any further render at all. A rename is the ordinary one.
		await renameNote(db, note.id, 'Renamed');
		await showing('Renamed');

		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(document.querySelector('.ProseMirror')?.textContent).toBe('what it says now');
	});
});

/**
 * The outline rail's jump, against the real editor.
 *
 * `outline.test.tsx` stands a plain `<div class="ProseMirror">` in for the
 * document, which is enough to pin which heading is chosen but not what
 * ProseMirror does about it: the rich jump moves the *browser's* selection and
 * lets `DOMObserver` read it back, so the only thing that can say whether that
 * turns into a transaction — and whether that transaction counts as an edit — is
 * a real editor with a real observer.
 *
 * The assertion leans on `useAutosave` flushing on unmount. A pending save is
 * two seconds away, so a note read straight after the click would look untouched
 * whether or not an edit was reported; unmounting first forces the question.
 */
describe('jumping from the outline', () => {
	it('moves the caret into the heading and reports no edit', async () => {
		const user = userEvent.setup();
		const note = await importNoteFile(db, {
			path: 'garden.md',
			source: '# Garden\n\nwords\n\n## Beds\n\nmore\n\n### Soil\n\nlast\n',
		});

		const view = render(<Harness id={note.id} />);
		await showing('Garden');

		await user.click(screen.getByRole('button', { name: 'Beds' }));

		await waitFor(() => {
			expect(document.activeElement?.className).toContain('ProseMirror');
		});
		expect(window.getSelection()?.anchorNode?.textContent).toBe('Beds');

		view.unmount();
		const after = await getNote(db, note.id);
		expect(after?.dirty).toBe(0);
		expect(after?.body).toBe(note.body);
		expect(after?.updatedAt).toBe(note.updatedAt);
	});
});

/**
 * The find bar over the real rich editor.
 *
 * `findBar.test.tsx` drives the bar over CodeMirror and `findRich.test.ts`
 * drives the rich target with no React around it, so between them the rich
 * editor's React integration — the editor offering itself, the bar dispatching
 * into a ProseMirror that has React-backed plugin views inside it — was the one
 * arrangement nothing exercised. It is also the one where a regular expression
 * matching nothing used to be a crash, so it is worth a real editor saying so.
 */
describe('finding in the rich editor', () => {
	// `Mod+F` is a registered command, not a listener of this component's own, so
	// the provider and the shortcut listener have to be around it — which is the
	// real arrangement (`routes/index.tsx`), not a convenience for the test.
	const Finding = ({ id }: { id: string }) => {
		useShortcuts();
		return <Harness id={id} />;
	};

	const openBar = async (user: ReturnType<typeof userEvent.setup>, source: string) => {
		const note = await importNoteFile(db, { path: 'note.md', source });
		const view = render(
			<CommandsProvider>
				<Finding id={note.id} />
			</CommandsProvider>
		);
		await showing(note.title);
		await user.keyboard('{Control>}f{/Control}');
		return { note, view };
	};

	it('draws the matches in the document', async () => {
		const user = userEvent.setup();
		await openBar(user, '# Garden\n\nthe seed and the seedling\n');

		await user.type(screen.getByLabelText('Find'), 'seed');

		expect(document.querySelectorAll('.ProseMirror .find-match')).toHaveLength(2);
		expect(screen.getByRole('search')).toBeDefined();
	});

	/** The crash: an empty mark decoration, thrown from inside the update cycle. */
	it('survives a regular expression that matches nothing at all', async () => {
		const user = userEvent.setup();
		await openBar(user, '# Garden\n\nbanana bread\n');

		await user.click(screen.getByLabelText('Regular expression'));
		await user.type(screen.getByLabelText('Find'), 'a*');

		expect(document.querySelector('.ProseMirror')?.textContent).toContain('banana bread');
	});

	it('replaces, and saves the note that results', async () => {
		const user = userEvent.setup();
		const { note, view } = await openBar(user, '# Garden\n\nthe seed and the seedling\n');
		await user.type(screen.getByLabelText('Find'), 'seed');
		await user.click(screen.getByLabelText('Show replace'));
		await user.type(screen.getByLabelText('Replace with'), 'bulb');

		await user.click(screen.getByRole('button', { name: 'All' }));
		expect(document.querySelector('.ProseMirror')?.textContent).toContain('the bulb and the');
		// The save is two seconds out; unmounting flushes it, as a mode switch or
		// moving to another note would.
		view.unmount();

		// The flush starts the write; it does not wait for it.
		await waitFor(async () => {
			expect((await getNote(db, note.id))?.body).toBe(
				'# Garden\n\nthe bulb and the bulbling\n'
			);
		});
		expect((await getNote(db, note.id))?.dirty).toBe(1);
	});

	/** Reading a note is not editing it, whichever editor is doing the reading. */
	it('does not touch the note for finding or moving', async () => {
		const user = userEvent.setup();
		const { note, view } = await openBar(user, '# Garden\n\nthe seed and the seedling\n');

		await user.type(screen.getByLabelText('Find'), 'seed');
		await user.keyboard('{Enter}{Enter}');
		await user.click(screen.getByLabelText('Previous match'));
		view.unmount();

		const after = await getNote(db, note.id);
		expect(after?.dirty).toBe(0);
		expect(after?.body).toBe(note.body);
		expect(after?.updatedAt).toBe(note.updatedAt);
	});
});
