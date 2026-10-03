import { undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Carried } from '../src/editor/addFiles.js';
import {
	type Added,
	type AttachmentHost,
	type AttachmentProblem,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { RawEditor } from '../src/editor/RawEditor.js';

/**
 * Files pasted or dropped into raw mode (#187): added beside the note, and put
 * in as the markdown that links them, as the user's own edit.
 */

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const fileNamed = (name: string, text = 'bytes') => new File([text], name);

const carrying = (files: File[], text = ''): Carried => ({
	files,
	getData: (format) => (format === 'text/plain' ? text : ''),
});

const added = (href: string, kind: 'image' | 'file', created = true): Added => ({
	state: 'added',
	fileId: `id-${href}`,
	href,
	label: href,
	kind,
	markdown: kind === 'image' ? `![${href}](${href})` : `[${href}](${href})`,
	created,
});

/** A host that answers each add from `answers`, in order, when the test lets it. */
const fakeHost = (answers: Added[]) => {
	const asked: { name: string; pasted: boolean }[] = [];
	const told: AttachmentProblem[] = [];
	const withdrawn: string[] = [];
	const gate = { open: (): void => undefined };
	const opened = new Promise<void>((resolve) => {
		gate.open = resolve;
	});
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		add: async (file, { pasted }) => {
			asked.push({ name: file.name, pasted });
			await opened;
			return answers[asked.length - 1] ?? { state: 'failed' };
		},
		withdraw: (fileId) => {
			withdrawn.push(fileId);
			return Promise.resolve();
		},
		report: (problem) => {
			told.push(problem);
		},
	};
	return { host, asked, told, withdrawn, open: gate.open };
};

const mount = (body: string, host: AttachmentHost) => {
	const onUserEdit = vi.fn();
	const rendered = render(
		<RawEditor noteId="a" body={body} onUserEdit={onUserEdit} attachments={host} />
	);
	const view = EditorView.findFromDOM(rendered.container);
	if (view === null) throw new Error('CodeMirror did not mount');
	return { ...rendered, view, onUserEdit };
};

const send = (view: EditorView, type: 'paste' | 'drop', data: Carried) => {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', {
		value: data,
	});
	view.contentDOM.dispatchEvent(event);
	return event;
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a file pasted into raw mode', () => {
	it('goes in as the markdown that links it, in place of the selection, as an edit', async () => {
		const { host, asked, open } = fakeHost([added('pasted-image-1a2b3c4d.png', 'image')]);
		const { view, onUserEdit } = mount('keep this out', host);
		view.dispatch({ selection: { anchor: 5, head: 9 } });

		const event = send(view, 'paste', carrying([fileNamed('image.png')]));
		expect(event.defaultPrevented).toBe(true);
		// The selection is taken at once, as by any paste, as in rich mode.
		expect(view.state.doc.toString()).toBe('keep  out');
		open();
		await vi.waitFor(() => {
			expect(onUserEdit).toHaveBeenCalledTimes(2);
		});

		expect(asked).toEqual([{ name: 'image.png', pasted: true }]);
		expect(view.state.doc.toString()).toBe(
			'keep ![pasted-image-1a2b3c4d.png](pasted-image-1a2b3c4d.png) out'
		);
		expect(view.state.selection.main.head).toBe(view.state.doc.length - ' out'.length);
	});

	it('keeps its place through what is typed meanwhile, every file of it together', async () => {
		const { host, open } = fakeHost([added('a.pdf', 'file'), added('b.pdf', 'file')]);
		const { view, onUserEdit } = mount('xy', host);
		view.dispatch({ selection: { anchor: 1 } });

		send(view, 'paste', carrying([fileNamed('a.pdf'), fileNamed('b.pdf')]));
		view.dispatch({ changes: { from: 0, insert: 'before ' } });
		open();
		await vi.waitFor(() => {
			expect(view.state.doc.toString()).toBe('before x[a.pdf](a.pdf)[b.pdf](b.pdf)y');
		});

		expect(onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('goes after what is typed where it was pasted meanwhile, an undo step of its own', async () => {
		const { host, open } = fakeHost([added('a.pdf', 'file')]);
		const { view } = mount('xy', host);
		view.dispatch({ selection: { anchor: 1 } });

		send(view, 'paste', carrying([fileNamed('a.pdf')]));
		view.dispatch({
			changes: { from: 1, insert: 'z' },
			selection: { anchor: 2 },
			userEvent: 'input.type',
		});
		open();
		await vi.waitFor(() => {
			expect(view.state.doc.toString()).toBe('xz[a.pdf](a.pdf)y');
		});
		expect(view.state.selection.main.head).toBe(view.state.doc.length - 'y'.length);

		undo(view);
		expect(view.state.doc.toString()).toBe('xzy');
	});

	it('leaves the cursor where the user took it meanwhile', async () => {
		const { host, open } = fakeHost([added('a.pdf', 'file')]);
		const { view } = mount('xy', host);
		view.dispatch({ selection: { anchor: 1 } });

		send(view, 'paste', carrying([fileNamed('a.pdf')]));
		view.dispatch({ selection: { anchor: 2 } });
		open();
		await vi.waitFor(() => {
			expect(view.state.doc.toString()).toBe('x[a.pdf](a.pdf)y');
		});

		expect(view.state.selection.main.head).toBe(view.state.doc.length);
	});

	it('is left to CodeMirror where the paste carries words of its own', async () => {
		const { host, asked } = fakeHost([]);
		const { view } = mount('', host);

		send(view, 'paste', carrying([fileNamed('image.png')], 'Q1 120'));
		await settled();

		expect(asked).toEqual([]);
		expect(view.state.doc.toString()).toBe('Q1 120');
	});

	it('puts nothing in, and says why, where every file was refused', async () => {
		const { host, told, open } = fakeHost([{ state: 'refused', reason: 'note' }]);
		const { view, onUserEdit } = mount('xy', host);
		const scrolled = vi.fn();
		view.dispatch({
			effects: StateEffect.appendConfig.of(
				EditorView.updateListener.of((update) => {
					if (update.transactions.some((tr) => tr.scrollIntoView)) scrolled();
				})
			),
		});

		send(view, 'paste', carrying([fileNamed('other.md')]));
		open();
		await vi.waitFor(() => {
			expect(told).toHaveLength(1);
		});
		await settled();

		expect(view.state.doc.toString()).toBe('xy');
		expect(onUserEdit).not.toHaveBeenCalled();
		// Nor is the note taken to where it would have gone.
		expect(scrolled).not.toHaveBeenCalled();
		expect(told[0]?.message).toBe(
			'other.md cannot be added: a .md file beside a note is another note.'
		);
	});

	it('is taken back where the note closed first, if this add made it', async () => {
		const { host, withdrawn, open } = fakeHost([
			added('a.pdf', 'file', true),
			added('b.pdf', 'file', false),
		]);
		const { view, unmount } = mount('xy', host);

		send(view, 'paste', carrying([fileNamed('a.pdf'), fileNamed('b.pdf')]));
		unmount();
		open();

		await vi.waitFor(() => {
			expect(withdrawn).toEqual(['id-a.pdf']);
		});
	});
});

describe('a file dropped into raw mode', () => {
	it('goes in where it was dropped, as a file of its own name', async () => {
		const { host, asked, open } = fakeHost([added('a.pdf', 'file')]);
		const { view } = mount('one two', host);
		vi.spyOn(view, 'posAtCoords').mockReturnValue(3);

		send(view, 'drop', carrying([fileNamed('a.pdf')]));
		open();
		await vi.waitFor(() => {
			expect(view.state.doc.toString()).toBe('one[a.pdf](a.pdf) two');
		});

		expect(asked).toEqual([{ name: 'a.pdf', pasted: false }]);
	});

	it('is left to CodeMirror where every file is a note, which puts its words in', async () => {
		const { host, asked } = fakeHost([]);
		const { view } = mount('', host);
		vi.spyOn(view, 'posAtCoords').mockReturnValue(0);

		send(view, 'drop', carrying([fileNamed('other.md', '# Other')]));
		await vi.waitFor(() => {
			expect(view.state.doc.toString()).toBe('# Other');
		});

		expect(asked).toEqual([]);
	});
});
