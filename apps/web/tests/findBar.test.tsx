import { EditorView } from '@codemirror/view';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FindBar } from '../src/components/FindBar.js';
import { FindTargetProvider } from '../src/editor/findTarget.js';
import { RawEditor } from '../src/editor/RawEditor.js';

/**
 * The bar, over a real CodeMirror document.
 *
 * Not the bar on its own with a stub behind it: what is worth testing is that
 * the thing the user types into and the thing that holds their note agree, and a
 * stub agrees with whatever it is written to agree with. jsdom carries
 * CodeMirror as far as dispatch (`RawEditor.test.tsx`), which is everything here
 * except where the viewport ends up.
 *
 * The rich editor's half is `findRich.test.ts` for the position mapping and
 * `RichEditor.switch.test.tsx` for the same round trip against a real Milkdown.
 */

afterEach(cleanup);

const BODY = 'one two one\nthree one four\n';

const open = (body = BODY) => {
	const onUserEdit = vi.fn();
	const onClose = vi.fn();
	const view = render(
		<FindTargetProvider>
			<RawEditor noteId="a" body={body} origin={body} onUserEdit={onUserEdit} />
			<FindBar focusToken={1} onClose={onClose} />
		</FindTargetProvider>
	);
	const editor = EditorView.findFromDOM(view.container);
	if (editor === null) throw new Error('CodeMirror did not mount');
	return { editor, onUserEdit, onClose };
};

const find = () => screen.getByLabelText('Find');
const count = () => screen.getByRole('status').textContent;
const doc = (editor: EditorView) => editor.state.doc.toString();
const marks = (editor: EditorView) => editor.dom.querySelectorAll('.cm-find-match').length;

describe('the find bar', () => {
	it('counts what it finds as the user types', async () => {
		const user = userEvent.setup();
		open();

		await user.type(find(), 'one');

		expect(count()).toBe('1 of 3');
	});

	it('says so when there is nothing to find', async () => {
		const user = userEvent.setup();
		open();

		await user.type(find(), 'zebra');

		expect(count()).toBe('No results');
	});

	it('draws every match in the document', async () => {
		const user = userEvent.setup();
		const { editor } = open();

		await user.type(find(), 'one');

		expect(marks(editor)).toBe(3);
	});

	it('moves to the next match on Enter, and wraps at the end', async () => {
		const user = userEvent.setup();
		const { editor } = open();
		await user.type(find(), 'one');

		await user.keyboard('{Enter}');
		expect(editor.state.selection.main.from).toBe(0);
		expect(count()).toBe('1 of 3');

		await user.keyboard('{Enter}{Enter}');
		expect(count()).toBe('3 of 3');

		await user.keyboard('{Enter}');
		expect(editor.state.selection.main.from).toBe(0);
		expect(count()).toBe('1 of 3');
	});

	it('goes back on Shift+Enter', async () => {
		const user = userEvent.setup();
		open();
		await user.type(find(), 'one');
		await user.keyboard('{Enter}{Enter}');

		await user.keyboard('{Shift>}{Enter}{/Shift}');

		expect(count()).toBe('1 of 3');
	});

	it('matches case only when asked, and the count says so', async () => {
		const user = userEvent.setup();
		open('One one ONE\n');
		await user.type(find(), 'one');
		expect(count()).toBe('1 of 3');

		await user.click(screen.getByLabelText('Match case'));

		expect(count()).toBe('1 of 1');
	});

	it('takes whole words only when asked', async () => {
		const user = userEvent.setup();
		open('cat cats scat\n');
		await user.type(find(), 'cat');
		expect(count()).toBe('1 of 3');

		await user.click(screen.getByLabelText('Whole word'));

		expect(count()).toBe('1 of 1');
	});

	describe('replacing', () => {
		const replacing = async (user: ReturnType<typeof userEvent.setup>, body = BODY) => {
			const opened = open(body);
			await user.click(screen.getByLabelText('Show replace'));
			return opened;
		};

		it('replaces the match the cursor is on and moves to the next', async () => {
			const user = userEvent.setup();
			const { editor } = await replacing(user);
			await user.type(find(), 'one');
			await user.keyboard('{Enter}');

			await user.type(screen.getByLabelText('Replace with'), 'single');
			await user.click(screen.getByRole('button', { name: 'Replace' }));

			expect(doc(editor)).toBe('single two one\nthree one four\n');
			expect(count()).toBe('1 of 2');
		});

		/**
		 * The count is read from the document after the replacement, not worked
		 * out from what it was before — so a replacement that still matches is
		 * counted, which is the honest answer and the surprising one. Replacing
		 * `one` with `ONE` while ignoring case leaves three matches, and a bar
		 * claiming two would be wrong the moment the user pressed next.
		 */
		it('counts a replacement that is itself still a match', async () => {
			const user = userEvent.setup();
			const { editor } = await replacing(user);
			await user.type(find(), 'one');
			await user.keyboard('{Enter}');
			await user.type(screen.getByLabelText('Replace with'), 'ONE');

			await user.click(screen.getByRole('button', { name: 'Replace' }));

			expect(doc(editor)).toBe('ONE two one\nthree one four\n');
			expect(count()).toBe('2 of 3');
		});

		/**
		 * The hard rule runs the other way here than everywhere else: this *is*
		 * the user editing the note, so it must be reported. `dirty.ts` decides
		 * by whether the transaction changed the document, which is why a
		 * replace counts and moving between matches does not.
		 */
		it('reports the replacement as a user edit', async () => {
			const user = userEvent.setup();
			const { onUserEdit } = await replacing(user);
			await user.type(find(), 'one');
			await user.keyboard('{Enter}');
			await user.type(screen.getByLabelText('Replace with'), 'single');

			await user.click(screen.getByRole('button', { name: 'Replace' }));

			expect(onUserEdit).toHaveBeenCalledWith('single two one\nthree one four\n', BODY);
		});

		it('replaces every match at once', async () => {
			const user = userEvent.setup();
			const { editor } = await replacing(user);
			await user.type(find(), 'one');
			await user.type(screen.getByLabelText('Replace with'), 'X');

			await user.click(screen.getByRole('button', { name: 'All' }));

			expect(doc(editor)).toBe('X two X\nthree X four\n');
			expect(count()).toBe('No results');
		});

		/** One transaction, so one press of undo takes the whole thing back. */
		it('undoes a replace-all in one step', async () => {
			const user = userEvent.setup();
			const { editor } = await replacing(user);
			await user.type(find(), 'one');
			await user.type(screen.getByLabelText('Replace with'), 'X');
			await user.click(screen.getByRole('button', { name: 'All' }));

			await user.click(editor.contentDOM);
			await user.keyboard('{Control>}z{/Control}');

			expect(doc(editor)).toBe(BODY);
		});

		/**
		 * Replace before anything has been found would otherwise rewrite whatever
		 * the cursor happened to be next to — which, the bar having just opened,
		 * is the start of the note.
		 */
		it('finds rather than replaces when the cursor is not on a match', async () => {
			const user = userEvent.setup();
			const { editor, onUserEdit } = await replacing(user);
			await user.type(find(), 'one');
			await user.type(screen.getByLabelText('Replace with'), 'single');

			await user.click(screen.getByRole('button', { name: 'Replace' }));

			expect(doc(editor)).toBe(BODY);
			expect(onUserEdit).not.toHaveBeenCalled();
			expect(editor.state.selection.main.from).toBe(0);
		});
	});

	/** Moving between matches is reading, not writing. */
	it('does not report an edit for finding or moving', async () => {
		const user = userEvent.setup();
		const { onUserEdit } = open();

		await user.type(find(), 'one');
		await user.keyboard('{Enter}{Enter}');
		await user.click(screen.getByLabelText('Previous match'));

		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('takes the highlighting away when it closes', async () => {
		const user = userEvent.setup();
		const { editor, onClose } = open();
		await user.type(find(), 'one');
		expect(marks(editor)).toBe(3);

		await user.click(screen.getByLabelText('Close find'));

		expect(onClose).toHaveBeenCalled();
	});

	it('closes on Escape', async () => {
		const user = userEvent.setup();
		const { onClose } = open();

		await user.type(find(), '{Escape}');

		expect(onClose).toHaveBeenCalled();
	});
});
