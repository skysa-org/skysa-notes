import { EditorView } from '@codemirror/view';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RawEditor } from '../src/editor/RawEditor.js';

/**
 * The editor half of the "dirty only on real edits" rule: loading a note, and
 * adopting a body that changed underneath the editor, must not report an edit.
 * `dirty.test.ts` covers the decision itself; this covers the wiring.
 */

const editorView = (container: HTMLElement): EditorView => {
	const view = EditorView.findFromDOM(container);
	if (view === null) throw new Error('CodeMirror did not mount');
	return view;
};

afterEach(cleanup);

describe('RawEditor', () => {
	it('renders the body it is given', () => {
		const { container } = render(
			<RawEditor noteId="a" body={'# Hello\n'} onUserEdit={vi.fn()} />
		);
		expect(editorView(container).state.doc.toString()).toBe('# Hello\n');
	});

	it('does not report an edit merely for mounting', () => {
		const onUserEdit = vi.fn();
		render(<RawEditor noteId="a" body="# Hello" onUserEdit={onUserEdit} />);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('reports a change the user typed', () => {
		const onUserEdit = vi.fn();
		const { container } = render(<RawEditor noteId="a" body="Hello" onUserEdit={onUserEdit} />);

		editorView(container).dispatch({ changes: { from: 5, insert: ' world' } });

		expect(onUserEdit).toHaveBeenCalledTimes(1);
		expect(onUserEdit).toHaveBeenCalledWith('Hello world', 0);
	});

	it('does not report an edit when the body changes underneath it', () => {
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="Hello" onUserEdit={onUserEdit} />
		);

		// As if sync pulled a newer version of the same note.
		rerender(<RawEditor noteId="a" body="Hello from elsewhere" onUserEdit={onUserEdit} />);

		expect(editorView(container).state.doc.toString()).toBe('Hello from elsewhere');
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('does not report an edit when a different note is opened', () => {
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="First note" onUserEdit={onUserEdit} />
		);

		rerender(<RawEditor noteId="b" body="Second note" onUserEdit={onUserEdit} />);

		expect(editorView(container).state.doc.toString()).toBe('Second note');
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('does not undo what the user typed while their last save was in flight', () => {
		// Autosave debounces, so the body coming back is always a couple of
		// seconds behind the screen. Adopting it would silently delete the
		// keystrokes made in between and throw the cursor to the end.
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="Hello" onUserEdit={onUserEdit} />
		);
		const view = editorView(container);

		// The debounce fires and 'Hello world' goes off to be saved...
		view.dispatch({ changes: { from: 5, insert: ' world' } });
		// ...and the user keeps typing while it is on its way.
		view.dispatch({ changes: { from: 11, insert: '!' } });
		// Now the save lands and the older body comes back as a prop.
		rerender(<RawEditor noteId="a" body="Hello world" onUserEdit={onUserEdit} />);

		expect(editorView(container).state.doc.toString()).toBe('Hello world!');
	});

	it('still takes a genuine change from elsewhere after saving its own', () => {
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="Hello" onUserEdit={onUserEdit} />
		);

		editorView(container).dispatch({ changes: { from: 5, insert: ' world' } });
		// Its own save comes back, and is ignored...
		rerender(<RawEditor noteId="a" body="Hello world" onUserEdit={onUserEdit} />);
		// ...but a write from somewhere else is not.
		rerender(<RawEditor noteId="a" body="Rewritten by sync" onUserEdit={onUserEdit} />);

		expect(editorView(container).state.doc.toString()).toBe('Rewritten by sync');
		expect(onUserEdit).toHaveBeenCalledTimes(1);
	});

	it('does not undo what the user typed when it re-renders for some other reason', () => {
		// The body prop is still the value from before the user started typing —
		// the save has not landed yet — so re-running the load would delete
		// everything typed since.
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="Hello" onUserEdit={onUserEdit} />
		);

		editorView(container).dispatch({ changes: { from: 5, insert: ' world' } });
		// Same note, same body, a new callback identity: a render caused by
		// something else entirely.
		rerender(<RawEditor noteId="a" body="Hello" onUserEdit={() => undefined} />);

		expect(editorView(container).state.doc.toString()).toBe('Hello world');
	});

	it('does nothing when the body it is handed is already what it holds', () => {
		const onUserEdit = vi.fn();
		const { container, rerender } = render(
			<RawEditor noteId="a" body="Same" onUserEdit={onUserEdit} />
		);
		const before = editorView(container);

		rerender(<RawEditor noteId="a" body="Same" onUserEdit={onUserEdit} />);

		expect(editorView(container)).toBe(before);
		expect(onUserEdit).not.toHaveBeenCalled();
	});
});
