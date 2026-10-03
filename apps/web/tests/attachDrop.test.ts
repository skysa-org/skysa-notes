import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { setBlockType } from '@milkdown/kit/prose/commands';
import { undo } from '@milkdown/kit/prose/history';
import { Slice } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Carried } from '../src/editor/addFiles.js';
import {
	type Added,
	type AttachmentHost,
	type AttachmentProblem,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';
import { settleEditors } from '../src/store/heldEdits.js';

/**
 * Files pasted or dropped into the rich editor (#187): a placeholder while each
 * is added, then the file in the note as the user's own edit, where it was put.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const fileNamed = (name: string) => new File(['bytes'], name);

/** A host whose adds are answered when the test says, in the order they were asked. */
const fakeHost = () => {
	const asked: { name: string; pasted: boolean }[] = [];
	const answers: ((added: Added) => void)[] = [];
	const told: AttachmentProblem[] = [];
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		add: (file, { pasted }) => {
			asked.push({ name: file.name, pasted });
			return new Promise((resolve) => {
				answers.push(resolve);
			});
		},
		report: (problem) => {
			told.push(problem);
		},
	};
	/** Answer the next add the editor is waiting on, and let it put the file in. */
	const answer = async (added: Added) => {
		await vi.waitFor(() => {
			expect(answers.length).toBeGreaterThan(0);
		});
		answers.shift()?.(added);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { host, asked, told, answer };
};

const added = (href: string, label: string, kind: 'image' | 'file'): Added => ({
	state: 'added',
	fileId: `id-${href}`,
	href,
	label,
	kind,
	markdown: kind === 'image' ? `![${label}](${href})` : `[${label}](${href})`,
});

const mount = async (body: string, host: AttachmentHost) => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body, onUserEdit, attachments: host }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	return {
		editor,
		view,
		root,
		onUserEdit,
		markdown: () => editor.action(currentMarkdown),
		pending: () =>
			[...root.querySelectorAll('.attachment-pending')].map((each) => each.textContent),
	};
};

const carrying = (files: File[], text = ''): Carried => ({
	files,
	getData: (format) => (format === 'text/plain' ? text : ''),
});

/** Paste as the editor is asked to: its own `handlePaste`. */
const paste = (view: EditorView, data: Carried): boolean =>
	view.someProp('handlePaste', (handle) =>
		handle(view, { clipboardData: data } as unknown as ClipboardEvent, Slice.empty)
	) === true;

/** Drop as the page would: a `drop` event with the files on it, `at` under the pointer. */
const drop = (view: EditorView, data: Carried, at: number) => {
	vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: at, inside: -1 });
	const event = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: data });
	view.dom.dispatchEvent(event);
	return event;
};

const cursorAt = (view: EditorView, from: number, to = from) => {
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
};

describe('a file pasted into the note', () => {
	it('is a placeholder while it is added, and then the picture, as an edit', async () => {
		const { host, asked, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);

		expect(paste(mounted.view, carrying([fileNamed('image.png')]))).toBe(true);

		expect(mounted.pending()).toEqual(['Adding image.png…']);
		expect(mounted.markdown()).toBe('xy\n');
		expect(mounted.onUserEdit).not.toHaveBeenCalled();

		await answer(added('pasted-image-1a2b3c4d.png', 'Pasted image', 'image'));
		expect(asked).toEqual([{ name: 'image.png', pasted: true }]);

		expect(mounted.pending()).toEqual([]);
		expect(mounted.markdown()).toBe('x![Pasted image](pasted-image-1a2b3c4d.png)y\n');
		expect(mounted.onUserEdit).toHaveBeenCalledTimes(1);
	});

	it('is a chip where it is not a picture, written as the host wrote its link', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		const link = added('q3-report-1a2b3c4d.pdf', 'Q3 report.pdf', 'file');

		paste(mounted.view, carrying([fileNamed('Q3 report.pdf')]));
		await answer(link);

		expect(mounted.root.querySelectorAll('.attachment')).toHaveLength(1);
		expect(mounted.markdown()).toBe(`x${link.state === 'added' ? link.markdown : ''}y\n`);
	});

	it('takes the place of what was selected', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('keep this out\n', host);
		cursorAt(mounted.view, 6, 10);

		paste(mounted.view, carrying([fileNamed('a.pdf')]));
		await answer(added('a-1a2b3c4d.pdf', 'a.pdf', 'file'));

		expect(mounted.markdown()).toBe('keep [a.pdf](a-1a2b3c4d.pdf) out\n');
	});

	it('goes in after the one before it, several at once, in the order they came', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);

		paste(mounted.view, carrying([fileNamed('a.pdf'), fileNamed('b.pdf')]));
		expect(mounted.pending()).toEqual(['Adding a.pdf…', 'Adding b.pdf…']);
		await answer(added('a.pdf', 'a.pdf', 'file'));
		expect(mounted.pending()).toEqual(['Adding b.pdf…']);
		await answer(added('b.pdf', 'b.pdf', 'file'));

		expect(mounted.markdown()).toBe('x[a.pdf](a.pdf)[b.pdf](b.pdf)y\n');
	});

	it('keeps its place through an edit made while it is added', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		paste(mounted.view, carrying([fileNamed('a.pdf')]));

		mounted.view.dispatch(mounted.view.state.tr.insertText('before ', 1));
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(mounted.markdown()).toBe('before x[a.pdf](a.pdf)y\n');
	});

	it('is an undo step of its own, apart from what was typed beside it meanwhile', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		paste(mounted.view, carrying([fileNamed('a.pdf')]));

		mounted.view.dispatch(mounted.view.state.tr.insertText('z'));
		await answer(added('a.pdf', 'a.pdf', 'file'));
		expect(mounted.markdown()).toBe('xz[a.pdf](a.pdf)y\n');

		undo(mounted.view.state, mounted.view.dispatch);
		expect(mounted.markdown()).toBe('xzy\n');
	});

	it('goes beside what it was in where that became a code block meanwhile', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		paste(mounted.view, carrying([fileNamed('a.pdf')]));

		const { state, dispatch } = mounted.view;
		const codeBlock = state.schema.nodes.code_block;
		if (codeBlock === undefined) throw new Error('no code block in the schema');
		setBlockType(codeBlock)(state, dispatch);
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(mounted.markdown()).toBe('[a.pdf](a.pdf)\n\n```\nxy\n```\n');
	});

	it('is not taken where the paste carries words of its own: they are pasted', async () => {
		const { host, asked } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);

		paste(mounted.view, carrying([fileNamed('image.png')], 'Q1 120'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(asked).toEqual([]);
		expect(mounted.pending()).toEqual([]);
		expect(mounted.markdown()).toContain('Q1 120');
	});

	it('leaves nothing, and says why, where it is refused', async () => {
		const { host, told, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);

		paste(mounted.view, carrying([fileNamed('film.mov')]));
		await answer({ state: 'refused', reason: 'too-large' });

		expect(mounted.pending()).toEqual([]);
		expect(mounted.markdown()).toBe('xy\n');
		expect(mounted.onUserEdit).not.toHaveBeenCalled();
		expect(told.map((problem) => problem.message)).toEqual([
			'film.mov is over 25 MB, the most a file beside a note can be.',
		]);
	});

	it('says to add it again where the note closed before it could go in, adding no more', async () => {
		const { host, asked, told, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		paste(mounted.view, carrying([fileNamed('a.pdf'), fileNamed('b.pdf')]));

		await mounted.editor.destroy();
		await answer(added('a.pdf', 'a.pdf', 'file'));

		// Kept beside the note, as a file whose link was taken out is; the
		// rest is not added at all.
		expect(asked.map((each) => each.name)).toEqual(['a.pdf']);
		expect(told.map((problem) => problem.message)).toEqual([
			'The note closed before 2 files could go in. Add them again to put them in.',
		]);
	});

	it('is waited for by whoever settles the editors, as an edit on its way', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		const settled = vi.fn();

		paste(mounted.view, carrying([fileNamed('a.pdf')]));
		void settleEditors().then(settled);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).not.toHaveBeenCalled();
		await answer(added('a.pdf', 'a.pdf', 'file'));

		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalled();
		});
	});

	it('says nothing more of a file refused where the note closed meanwhile', async () => {
		const { host, told, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		paste(mounted.view, carrying([fileNamed('film.mov')]));

		await mounted.editor.destroy();
		await answer({ state: 'refused', reason: 'too-large' });

		expect(told.map((problem) => problem.message)).toEqual([
			'film.mov is over 25 MB, the most a file beside a note can be.',
		]);
	});
});

describe('a file dropped on the note', () => {
	it('goes where it was dropped, as a file of its own name', async () => {
		const { host, asked, answer } = fakeHost();
		const mounted = await mount('one two\n', host);

		const event = drop(mounted.view, carrying([fileNamed('a.pdf')], 'ignored'), 4);
		expect(event.defaultPrevented).toBe(true);
		// Ready to be typed in, as after a drop of words.
		expect(document.activeElement).toBe(mounted.view.dom);
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(asked).toEqual([{ name: 'a.pdf', pasted: false }]);
		expect(mounted.markdown()).toBe('one[a.pdf](a.pdf) two\n');
	});

	it('is waited for by whoever settles the editors', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('one two\n', host);
		const settled = vi.fn();

		drop(mounted.view, carrying([fileNamed('a.pdf')]), 4);
		void settleEditors().then(settled);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).not.toHaveBeenCalled();
		await answer(added('a.pdf', 'a.pdf', 'file'));

		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalled();
		});
	});

	it('goes beside a block that holds no file, in a paragraph of its own', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('```\ncode\n```\n', host);

		// At the end of the code: after the block, rather than before it.
		drop(mounted.view, carrying([fileNamed('a.pdf')]), 5);
		// Shown where it is going, not in the code.
		expect(mounted.pending()).toEqual(['Adding a.pdf…']);
		expect(mounted.root.querySelector('.attachment-pending')?.closest('pre')).toBeNull();
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(mounted.markdown()).toBe('```\ncode\n```\n\n[a.pdf](a.pdf)\n');
	});

	it('goes in the nearest cell where it lands between the cells of a table, not a new column', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('| a | b |\n| - | - |\n| 1 | 2 |\n', host);

		// Inside the second row, before its first cell.
		drop(mounted.view, carrying([fileNamed('a.pdf')]), 14);
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(mounted.markdown()).toBe(
			[
				'| a               | b |',
				'| --------------- | - |',
				'| [a.pdf](a.pdf)1 | 2 |',
				'',
			].join('\n')
		);
	});

	it('is left to ProseMirror where the drag began in the note', async () => {
		const { host, asked } = fakeHost();
		const mounted = await mount('one two\n', host);
		Object.defineProperty(mounted.view, 'dragging', {
			value: { slice: Slice.empty, move: true },
		});

		drop(mounted.view, carrying([fileNamed('a.pdf')]), 4);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(asked).toEqual([]);
		expect(mounted.pending()).toEqual([]);
	});
});
