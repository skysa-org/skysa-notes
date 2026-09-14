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
		expect(onUserEdit).toHaveBeenCalledWith('Hello world');
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
