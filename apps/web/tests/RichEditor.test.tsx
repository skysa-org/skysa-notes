import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adoptBody, representsFaithfully, type RichEditorSetup } from '../src/editor/rich.js';
import { RichEditor } from '../src/editor/RichEditor.js';

/**
 * The React side of rich mode: when a body is loaded into the editor and when it
 * is not. The editor itself is stubbed — jsdom cannot type into a ProseMirror
 * surface, and what is under test here is the wiring, not the document model.
 * `rich.test.ts` drives the real editor; `incoming.test.tsx` covers the rule.
 */

let setup: RichEditorSetup | undefined;

vi.mock('../src/editor/rich.js', () => ({
	createRichEditor: (options: RichEditorSetup) => {
		setup = options;
		return {
			create: () => Promise.resolve({ action: (fn: (ctx: unknown) => unknown) => fn({}) }),
			// Milkdown's React binding destroys the editor it was handed, not the
			// one `create` resolved to.
			destroy: () => Promise.resolve(),
		};
	},
	adoptBody: vi.fn(() => true),
	representsFaithfully: vi.fn(() => true),
}));

const mounted = async () => {
	await waitFor(() => {
		expect(setup).toBeDefined();
	});
	// The fidelity check runs as soon as the editor exists, so it is the signal
	// that the effects have caught up with it.
	await waitFor(() => {
		expect(representsFaithfully).toHaveBeenCalled();
	});
};

beforeEach(() => {
	setup = undefined;
	vi.mocked(adoptBody).mockClear();
	vi.mocked(representsFaithfully).mockClear();
});

afterEach(cleanup);

describe('RichEditor', () => {
	it('opens the editor on the body it is given, and calls that no edit', async () => {
		const onUserEdit = vi.fn();
		render(
			<RichEditor
				noteId="a"
				body={'# Hello\n'}
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await mounted();

		expect(setup?.body).toBe('# Hello\n');
		expect(onUserEdit).not.toHaveBeenCalled();
		expect(adoptBody).not.toHaveBeenCalled();
	});

	it('loads a body that changed underneath it', async () => {
		const { rerender } = render(
			<RichEditor noteId="a" body="Hello" onUserEdit={vi.fn()} onUnsupported={vi.fn()} />
		);
		await mounted();

		rerender(
			<RichEditor
				noteId="a"
				body="Rewritten by sync"
				onUserEdit={vi.fn()}
				onUnsupported={vi.fn()}
			/>
		);

		await waitFor(() => {
			expect(adoptBody).toHaveBeenCalledWith(expect.anything(), 'Rewritten by sync');
		});
	});

	it('reports an edit with the origin of the body it was typed into', async () => {
		const onUserEdit = vi.fn();
		const { rerender } = render(
			<RichEditor
				noteId="a"
				body="Hello"
				origin="o2"
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await mounted();

		act(() => {
			setup?.onUserEdit('Hello world');
		});
		expect(onUserEdit).toHaveBeenLastCalledWith('Hello world', 'o2');

		rerender(
			<RichEditor
				noteId="a"
				body="Pulled"
				origin="o3"
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await waitFor(() => {
			expect(adoptBody).toHaveBeenCalledWith(expect.anything(), 'Pulled');
		});
		act(() => {
			setup?.onUserEdit('Pulled!');
		});
		expect(onUserEdit).toHaveBeenLastCalledWith('Pulled!', 'o3');
	});

	it('keeps reporting the old origin while a body from outside could not be taken in', async () => {
		const onUserEdit = vi.fn();
		const { rerender } = render(
			<RichEditor
				noteId="a"
				body="Hello"
				origin="o1"
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await mounted();
		vi.mocked(adoptBody).mockReturnValueOnce(false);

		rerender(
			<RichEditor
				noteId="a"
				body="Unparseable"
				origin="o2"
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await waitFor(() => {
			expect(adoptBody).toHaveBeenCalledWith(expect.anything(), 'Unparseable');
		});
		act(() => {
			setup?.onUserEdit('Hello!');
		});

		// Still the text from o1 on screen, so the edit is one against o1.
		expect(onUserEdit).toHaveBeenLastCalledWith('Hello!', 'o1');
	});

	it('does not reload the note when it re-renders for some other reason', async () => {
		// The trap: the body prop is still the value from before the user started
		// typing, because the save has not landed yet. Loading it again would
		// delete everything typed since — and this component re-renders often,
		// because the editor instance getter changes identity every time.
		const { rerender } = render(
			<RichEditor noteId="a" body="Hello" onUserEdit={vi.fn()} onUnsupported={vi.fn()} />
		);
		await mounted();

		act(() => {
			setup?.onUserEdit('Hello world');
		});
		rerender(
			<RichEditor noteId="a" body="Hello" onUserEdit={vi.fn()} onUnsupported={vi.fn()} />
		);
		rerender(
			<RichEditor noteId="a" body="Hello" onUserEdit={vi.fn()} onUnsupported={vi.fn()} />
		);

		expect(adoptBody).not.toHaveBeenCalled();
	});

	it('does not reload the note when its own save comes back', async () => {
		const { rerender } = render(
			<RichEditor noteId="a" body="Hello" onUserEdit={vi.fn()} onUnsupported={vi.fn()} />
		);
		await mounted();

		act(() => {
			setup?.onUserEdit('Hello world');
		});
		// The save lands, and the editor is handed back what it wrote.
		rerender(
			<RichEditor
				noteId="a"
				body="Hello world"
				onUserEdit={vi.fn()}
				onUnsupported={vi.fn()}
			/>
		);

		expect(adoptBody).not.toHaveBeenCalled();
	});

	it('reports a note the editor cannot represent', async () => {
		vi.mocked(representsFaithfully).mockReturnValueOnce(false);
		const onUnsupported = vi.fn();

		render(
			<RichEditor
				noteId="a"
				body="something exotic"
				onUserEdit={vi.fn()}
				onUnsupported={onUnsupported}
			/>
		);

		await waitFor(() => {
			expect(onUnsupported).toHaveBeenCalled();
		});
	});

	/**
	 * The check on the body the editor was built with runs once, so a body that
	 * arrives afterwards — a sync pull, or an edit made in raw mode — is the only
	 * other thing that can put markdown into this editor, and the only other
	 * place the question can be asked.
	 */
	it('reports a body that arrives later and cannot be represented', async () => {
		const onUnsupported = vi.fn();
		const props = { noteId: 'a', onUserEdit: vi.fn(), onUnsupported };

		const { rerender } = render(<RichEditor {...props} body="ordinary enough" />);
		await waitFor(() => {
			expect(representsFaithfully).toHaveBeenCalled();
		});
		expect(onUnsupported).not.toHaveBeenCalled();

		vi.mocked(representsFaithfully).mockReturnValueOnce(false);
		rerender(<RichEditor {...props} body="something exotic from the remote" />);

		await waitFor(() => {
			expect(onUnsupported).toHaveBeenCalled();
		});
	});
});
