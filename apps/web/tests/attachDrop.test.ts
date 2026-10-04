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
	type FileReceiver,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { INSERT_COMMANDS, SLASH_COMMANDS } from '../src/editor/commands.js';
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
		expect(mounted.markdown()).toBe('x\n\n![Pasted image](pasted-image-1a2b3c4d.png)\n\ny\n');
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
			'The editor closed before 2 files could go in. Add them again to put them in.',
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

const picture = (name: string) => added(`${name}.png`, name, 'image');

/** Paste pictures at `at` in `body`, each answered in turn; the note they leave. */
const picturesAt = async (body: string, at: number, ...names: string[]) => {
	const { host, answer } = fakeHost();
	const mounted = await mount(body, host);
	cursorAt(mounted.view, at);
	paste(mounted.view, carrying(names.map((name) => fileNamed(`${name}.png`))));
	for (const name of names) await answer(picture(name));
	return mounted;
};

describe('a picture put in the note', () => {
	it('goes in a paragraph of its own after the words it lands at the end of', async () => {
		const mounted = await picturesAt('Packing list for the coast\n', 27, 'a');

		expect(mounted.markdown()).toBe('Packing list for the coast\n\n![a](a.png)\n');
	});

	it('goes in a paragraph of its own before the words it lands at the start of', async () => {
		const mounted = await picturesAt('words\n', 1, 'a');

		expect(mounted.markdown()).toBe('![a](a.png)\n\nwords\n');
	});

	it('goes in an empty paragraph as it is', async () => {
		const mounted = await picturesAt('one\n\n\ntwo\n', 6, 'a');

		expect(mounted.markdown()).toBe('one\n\n![a](a.png)\n\ntwo\n');
	});

	it('goes in a paragraph of its own beside another picture', async () => {
		const mounted = await picturesAt('![a](a.png)\n', 2, 'b');

		expect(mounted.markdown()).toBe('![a](a.png)\n\n![b](b.png)\n');
	});

	it('keeps the order they came in, several at once, at the end or the middle', async () => {
		const atEnd = await picturesAt('xy\n', 3, 'a', 'b');
		expect(atEnd.markdown()).toBe('xy\n\n![a](a.png)\n\n![b](b.png)\n');

		const inMiddle = await picturesAt('xy\n', 2, 'a', 'b');
		expect(inMiddle.markdown()).toBe('x\n\n![a](a.png)\n\n![b](b.png)\n\ny\n');

		const atStart = await picturesAt('xy\n', 1, 'a', 'b');
		expect(atStart.markdown()).toBe('![a](a.png)\n\n![b](b.png)\n\nxy\n');
	});

	it('leaves the cursor after it, where the next thing typed goes', async () => {
		const mounted = await picturesAt('xy\n', 2, 'a');

		mounted.view.dispatch(mounted.view.state.tr.insertText('z'));

		expect(mounted.markdown()).toBe('x\n\n![a](a.png)\n\nzy\n');
	});

	it('is an undo step of its own, split and all', async () => {
		const mounted = await picturesAt('xy\n', 2, 'a');

		undo(mounted.view.state, mounted.view.dispatch);

		expect(mounted.markdown()).toBe('xy\n');
	});

	it('goes in a paragraph of its own inside the list item or quote it lands in', async () => {
		const listed = await picturesAt('- one\n- two\n', 6, 'a');
		expect(listed.markdown()).toBe('- one\n\n  ![a](a.png)\n- two\n');

		const quoted = await picturesAt('> one\n', 5, 'a');
		expect(quoted.markdown()).toBe('> one\n>\n> ![a](a.png)\n');
	});

	it('goes where it lands in a heading, or a table’s cell, which hold one line', async () => {
		const headed = await picturesAt('# Head\n', 5, 'a');
		expect(headed.markdown()).toBe('# Head![a](a.png)\n');

		const tabled = await picturesAt('| a | b |\n| - | - |\n| 1 | 2 |\n', 5, 'a');
		expect(tabled.markdown().split('\n')[0]).toBe('| a![a](a.png) | b |');
	});

	it('takes the spaces either side of it, which markdown would write as `&#x20;`', async () => {
		const atEnd = await picturesAt('Look at this: \n', 15, 'a');
		expect(atEnd.markdown()).toBe('Look at this:\n\n![a](a.png)\n');

		const inMiddle = await picturesAt('one two\n', 5, 'a');
		expect(inMiddle.markdown()).toBe('one\n\n![a](a.png)\n\ntwo\n');
	});

	it('goes in a paragraph of nothing but spaces as it is, the spaces gone', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('one\n\n\ntwo\n', host);
		mounted.view.dispatch(mounted.view.state.tr.insertText('   ', 6));
		cursorAt(mounted.view, 8);

		paste(mounted.view, carrying([fileNamed('a.png')]));
		await answer(picture('a'));

		expect(mounted.markdown()).toBe('one\n\n![a](a.png)\n\ntwo\n');
	});

	it('takes a line break beside it, which would be an empty line', async () => {
		const hard = await picturesAt('a\\\nb\n', 2, 'a');
		expect(hard.markdown()).toBe('a\n\n![a](a.png)\n\nb\n');

		const soft = await picturesAt('a\nb\n', 2, 'a');
		expect(soft.markdown()).toBe('a\n\n![a](a.png)\n\nb\n');
	});

	it('goes after the one before it, pasted one after another at the end of the words', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 3);

		paste(mounted.view, carrying([fileNamed('a.png')]));
		await answer(picture('a'));
		paste(mounted.view, carrying([fileNamed('b.png')]));
		await answer(picture('b'));

		expect(mounted.markdown()).toBe('xy\n\n![a](a.png)\n\n![b](b.png)\n');
	});

	it('goes where it lands at the very start of a list item, whose line is its checkbox’s', async () => {
		const mounted = await picturesAt('- [ ] todo\n', 3, 'a');

		expect(mounted.markdown()).toBe('- [ ] ![a](a.png)todo\n');
	});

	it('leaves a file’s chip in the line, as a name among the words', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 3);
		paste(mounted.view, carrying([fileNamed('a.png'), fileNamed('b.pdf')]));
		await answer(picture('a'));
		await answer(added('b.pdf', 'b.pdf', 'file'));

		expect(mounted.markdown()).toBe('xy\n\n![a](a.png)[b.pdf](b.pdf)\n');
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

	it('goes in the cell it lands at the end of, or the last, never the next', async () => {
		const table = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';
		const endOf = async (at: number) => {
			const { host, answer } = fakeHost();
			const mounted = await mount(table, host);
			drop(mounted.view, carrying([fileNamed('a.pdf')]), at);
			await answer(added('a.pdf', 'a.pdf', 'file'));
			return mounted.markdown().split('\n');
		};

		// The end of the first cell, after its paragraph.
		expect((await endOf(6))[0]).toBe('| a[a.pdf](a.pdf) | b |');
		// The end of the table, after its last row.
		expect((await endOf(25))[2]).toBe('| 1 | 2[a.pdf](a.pdf) |');
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

/** The picker the command opened, answered as the user would answer it. */
const picker = (): HTMLInputElement => {
	const input = document.querySelector<HTMLInputElement>('input[type="file"]');
	if (input === null) throw new Error('no picker is open');
	return input;
};

const choose = (files: File[]) => {
	const input = picker();
	Object.defineProperty(input, 'files', { value: files });
	input.dispatchEvent(new Event('change'));
};

/** The slash menu's or the toolbar's. */
const commandNamed = (id: string) => {
	const command = [...SLASH_COMMANDS, ...INSERT_COMMANDS].find((each) => each.id === id);
	if (command === undefined) throw new Error(`no command "${id}"`);
	return command;
};

describe('files picked for the note', () => {
	it('are asked for, and go in place of the selection as an edit', async () => {
		const { host, asked, answer } = fakeHost();
		const mounted = await mount('keep this out\n', host);
		cursorAt(mounted.view, 6, 10);

		mounted.editor.action(commandNamed('attach').apply);
		expect(picker().hasAttribute('accept')).toBe(false);
		choose([fileNamed('a.pdf')]);

		await vi.waitFor(() => {
			expect(mounted.pending()).toEqual(['Adding a.pdf…']);
		});
		await answer(added('a-1a2b3c4d.pdf', 'a.pdf', 'file'));
		expect(asked).toEqual([{ name: 'a.pdf', pasted: false }]);
		expect(mounted.markdown()).toBe('keep [a.pdf](a-1a2b3c4d.pdf) out\n');
		// The selection taken out once a file is chosen, then the file in.
		expect(mounted.onUserEdit.mock.calls).toEqual([
			['keep  out\n'],
			['keep [a.pdf](a-1a2b3c4d.pdf) out\n'],
		]);
	});

	it('are pictures from the slash menu, or any file', async () => {
		const mounted = await mount('xy\n', fakeHost().host);

		mounted.editor.action(commandNamed('image').apply);
		expect(picker().getAttribute('accept')).toBe('image/*');
		picker().dispatchEvent(new Event('cancel'));

		mounted.editor.action(commandNamed('file').apply);
		expect(picker().hasAttribute('accept')).toBe(false);
	});

	it('change nothing where none is chosen, not even the selection', async () => {
		const { host, asked } = fakeHost();
		const mounted = await mount('keep this out\n', host);
		cursorAt(mounted.view, 6, 10);

		mounted.editor.action(commandNamed('attach').apply);
		picker().dispatchEvent(new Event('cancel'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(asked).toEqual([]);
		expect(mounted.markdown()).toBe('keep this out\n');
		expect(mounted.view.state.selection.from).toBe(6);
		expect(mounted.view.state.selection.to).toBe(10);
		expect(mounted.onUserEdit).not.toHaveBeenCalled();
	});

	it('are said to be for adding again where the note closed while the picker was open', async () => {
		const { host, asked, told } = fakeHost();
		const mounted = await mount('xy\n', host);

		mounted.editor.action(commandNamed('attach').apply);
		await mounted.editor.destroy();
		choose([fileNamed('a.pdf'), fileNamed('b.pdf')]);

		await vi.waitFor(() => {
			expect(told.map((problem) => problem.message)).toEqual([
				'The editor closed before 2 files could go in. Add them again to put them in.',
			]);
		});
		expect(asked).toEqual([]);
	});

	it('are waited for by whoever settles the editors', async () => {
		const { host, answer } = fakeHost();
		const mounted = await mount('xy\n', host);
		const settled = vi.fn();

		mounted.editor.action(commandNamed('attach').apply);
		choose([fileNamed('a.pdf')]);
		await vi.waitFor(() => {
			expect(mounted.pending()).toHaveLength(1);
		});
		void settleEditors().then(settled);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).not.toHaveBeenCalled();
		await answer(added('a.pdf', 'a.pdf', 'file'));

		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalled();
		});
	});
});

describe('files picked from outside the editor', () => {
	/** A host that keeps whatever editor offers itself to it. */
	const receiving = () => {
		const fake = fakeHost();
		const offered: FileReceiver[] = [];
		const withdrawn: FileReceiver[] = [];
		const host: AttachmentHost = {
			...fake.host,
			receive: (receiver) => {
				offered.push(receiver);
				return () => {
					withdrawn.push(receiver);
				};
			},
		};
		return { ...fake, host, offered, withdrawn };
	};

	it('go into the editor open now, at its selection, focused', async () => {
		const { host, offered, asked, answer } = receiving();
		const mounted = await mount('xy\n', host);
		cursorAt(mounted.view, 2);
		const focus = vi.spyOn(mounted.view, 'focus');

		expect(offered).toHaveLength(1);
		offered[0]?.([fileNamed('a.pdf')]);
		await answer(added('a.pdf', 'a.pdf', 'file'));

		expect(focus).toHaveBeenCalled();
		expect(asked).toEqual([{ name: 'a.pdf', pasted: false }]);
		expect(mounted.markdown()).toBe('x[a.pdf](a.pdf)y\n');
	});

	it('stop going into an editor once it has closed', async () => {
		const { host, offered, withdrawn } = receiving();
		const mounted = await mount('xy\n', host);

		await mounted.editor.destroy();

		expect(withdrawn).toEqual(offered);
		expect(withdrawn).toHaveLength(1);
	});
});
