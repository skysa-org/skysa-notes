import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { DOMParser as ProseParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { NodeSelection, Selection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	type AttachmentHost,
	type AttachmentProblem,
	type Fetched,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * A file beside a note in the rich editor (#187): a chip, read from a link and
 * written back as one, that opens and saves its file through the host.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** A host that hands over `answer` for every file, and keeps what it was told. */
const fakeHost = (answer: Fetched = { state: 'missing' }) => {
	const asked: string[] = [];
	const told: AttachmentProblem[] = [];
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		fetchFile: (href) => {
			asked.push(href);
			return Promise.resolve(answer);
		},
		report: (problem) => {
			told.push(problem);
		},
	};
	return { host, asked, told };
};

const mount = async (body: string, host: AttachmentHost = NO_ATTACHMENTS) => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body, onUserEdit, attachments: host }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	const chips = () => [...root.querySelectorAll('.attachment')];
	return {
		editor,
		view,
		root,
		onUserEdit,
		chips,
		markdown: () => editor.action(currentMarkdown),
		/** Where the first chip is in the document. */
		chipAt: () => {
			const found = { current: -1 };
			view.state.doc.descendants((node, pos) => {
				if (found.current === -1 && node.type.name === 'attachment') found.current = pos;
			});
			return found.current;
		},
	};
};

/** What kind of node each of a paragraph's children is, text by its words. */
const shapeOf = (view: { state: { doc: { firstChild: unknown } } }): string[] => {
	const first = view.state.doc.firstChild as {
		forEach: (
			f: (node: {
				type: { name: string };
				text?: string;
				marks: { type: { name: string } }[];
			}) => void
		) => void;
	};
	const shape: string[] = [];
	first.forEach((node) => {
		const marks = node.marks.map((mark) => mark.type.name).join('+');
		shape.push(`${node.type.name}${marks === '' ? '' : `[${marks}]`}`);
	});
	return shape;
};

describe('a link to a file beside the note', () => {
	it.each([
		'See [Q3 report.pdf](q3-report-1a2b3c4d.pdf) here.\n',
		'[a b.pdf](<a b.pdf>)\n',
		'[a b.pdf](a%20b.pdf "The report")\n',
		'[notes](../archive/notes-1a2b3c4d.txt)\n',
		'*[Q3 report.pdf](q3.pdf)* and **[data](data.csv)**\n',
		'[ spaced ](spaced.zip)\n',
		'[](unnamed.pdf)\n',
		'[\\*not emphasis\\*](a.pdf)\n',
	])('is a chip, written back as it was: %j', async (body) => {
		const { view, markdown } = await mount(body);

		expect(shapeOf(view).some((name) => name.startsWith('attachment'))).toBe(true);
		expect(markdown()).toBe(body);
	});

	it('is claimed by the chip before the link mark can claim it', async () => {
		const { view } = await mount('See [Q3.pdf](q3.pdf) and *[a](a.zip)*.\n');

		expect(shapeOf(view)).toEqual([
			'text',
			'attachment',
			'text',
			'attachment[emphasis]',
			'text',
		]);
	});

	it('stays a link, every word kept, where plain words come before formatted ones', async () => {
		const { view } = await mount('A [Q3 *report*](q3.pdf) here.\n');

		expect(shapeOf(view)).toEqual(['text', 'text[link]', 'text[emphasis+link]', 'text']);
	});

	it('stays a link where its words are more than one run of text', async () => {
		// Written back by the link mark as Milkdown writes any such link, which
		// splits it, and the fidelity check sends the note to raw mode, as before
		// there were chips. What matters here is that it is not made a chip.
		const { view } = await mount('A [*Q3* report](q3.pdf) here.\n');

		expect(shapeOf(view)).toEqual(['text', 'text[emphasis+link]', 'text[link]', 'text']);
	});

	it.each([
		['code', 'A [`q3.pdf`](q3.pdf) here.\n'],
		['another note', 'A [plan](plan.md) here.\n'],
		['the web', 'A [report](https://example.com/q3.pdf) here.\n'],
		['a file with no extension', 'A [notes](README) here.\n'],
		['somewhere outside the library', 'A [report](/q3.pdf) here.\n'],
	])('stays a link where it points at %s', async (_, body) => {
		const { view, markdown } = await mount(body);

		expect(shapeOf(view).some((name) => name.startsWith('attachment'))).toBe(false);
		expect(markdown()).toBe(body);
	});

	it('is the same chip after an edit elsewhere in the note, byte for byte', async () => {
		const body = 'See [a b.pdf](<a b.pdf> "t") here.\n';
		const { view, onUserEdit } = await mount(body);

		view.dispatch(view.state.tr.insertText('!', Selection.atEnd(view.state.doc).from));

		expect(onUserEdit).toHaveBeenLastCalledWith('See [a b.pdf](<a b.pdf> "t") here.!\n');
	});
});

/** Select the first chip whole, as a click on it or the arrow keys would. */
const selectChip = (mounted: Awaited<ReturnType<typeof mount>>) => {
	const { view, chipAt } = mounted;
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, chipAt())));
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a chip', () => {
	it("shows the file's kind and its name, and tells a screen reader both", async () => {
		const { chips } = await mount('See [Q3 report.pdf](q3-1a2b3c4d.pdf "Figures") here.\n');
		const [chip] = chips();

		expect(chip?.querySelector('.attachment-name')?.textContent).toBe('Q3 report.pdf');
		expect(chip?.querySelector('.attachment-icon svg')).not.toBeNull();
		const link = chip?.querySelector('[role="link"]');
		expect(link?.getAttribute('aria-label')).toBe('Q3 report.pdf, PDF');
		expect(link?.getAttribute('title')).toBe('Figures');
	});

	it('draws each kind of file with its own icon', async () => {
		const { chips } = await mount('[a](a.pdf) [b](b.zip) [c](c.csv) [d](d.pdf)\n');
		const icons = chips().map((chip) => chip.querySelector('.attachment-icon')?.innerHTML);

		expect(new Set(icons).size).toBe(3);
		expect(icons[0]).toBe(icons[3]);
	});

	it('shows a file with no words by the name in its link', async () => {
		const { chips } = await mount('[](the%20data.csv)\n');

		expect(chips()[0]?.querySelector('.attachment-name')?.textContent).toBe('the data.csv');
		expect(chips()[0]?.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
			'the data.csv, Spreadsheet'
		);
	});

	it('offers its actions while it is selected, and only then', async () => {
		const mounted = await mount('A [a.zip](a.zip) b.\n');
		const actions = () => mounted.chips()[0]?.querySelector('.attachment-actions');
		expect(actions()?.hasAttribute('hidden')).toBe(true);

		selectChip(mounted);
		expect(actions()?.hasAttribute('hidden')).toBe(false);
		expect(mounted.chips()[0]?.hasAttribute('data-selected')).toBe(true);
		mounted.view.dispatch(
			mounted.view.state.tr.setSelection(Selection.atStart(mounted.view.state.doc))
		);

		expect(actions()?.hasAttribute('hidden')).toBe(true);
	});

	it('opens and saves its file through the host, saying what went wrong, and is no edit', async () => {
		const { host, asked, told } = fakeHost({ state: 'missing' });
		const mounted = await mount('A [Q3.pdf](q3.pdf) b.\n', host);
		const dispatch = vi.spyOn(mounted.view, 'dispatch');
		const press = (label: string) =>
			mounted
				.chips()[0]
				?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
				?.click();
		vi.spyOn(window, 'open').mockReturnValue(null);

		press('Open');
		press('Download');
		await settled();

		expect(asked).toEqual(['q3.pdf', 'q3.pdf']);
		expect(told.map((problem) => problem.message)).toEqual([
			'Q3.pdf could not be found beside this note.',
			'Q3.pdf could not be found beside this note.',
		]);
		expect(dispatch).not.toHaveBeenCalled();
		expect(mounted.onUserEdit).not.toHaveBeenCalled();
	});

	it('opens a PDF in the tab it opened while the press still counted', async () => {
		const { host } = fakeHost({
			state: 'ready',
			file: new File(['%PDF'], 'q3.pdf', { type: 'application/pdf' }),
		});
		const mounted = await mount('A [Q3.pdf](q3.pdf) b.\n', host);
		const replace = vi.fn();
		const open = vi
			.spyOn(window, 'open')
			.mockReturnValue({ location: { replace }, close: vi.fn() } as unknown as Window);
		vi.stubGlobal(
			'URL',
			class extends URL {
				static override createObjectURL = () => 'blob:test/q3';
				static override revokeObjectURL = () => undefined;
			}
		);

		mounted.chips()[0]?.querySelector<HTMLButtonElement>('[aria-label="Open"]')?.click();
		expect(open).toHaveBeenCalledWith('about:blank', '_blank');
		await settled();

		expect(replace).toHaveBeenCalledWith('blob:test/q3');
	});

	it('keeps itself selected when its bar is pressed', async () => {
		const mounted = await mount('A [a.zip](a.zip) b.\n');
		selectChip(mounted);
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

		mounted.chips()[0]?.querySelector('[aria-label="Open"]')?.dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
	});

	it('is busy while its file is fetched', async () => {
		const answer = { current: (_: Fetched): void => undefined };
		const host: AttachmentHost = {
			...NO_ATTACHMENTS,
			fetchFile: () =>
				new Promise((resolve) => {
					answer.current = resolve;
				}),
		};
		const { chips } = await mount('[a.zip](a.zip)\n', host);

		chips()[0]?.querySelector<HTMLButtonElement>('[aria-label="Download"]')?.click();
		expect(chips()[0]?.getAttribute('aria-busy')).toBe('true');
		answer.current({ state: 'aborted' });
		await settled();

		expect(chips()[0]?.hasAttribute('aria-busy')).toBe(false);
	});

	it('opens on a double click, and on a click with the modifier held', async () => {
		const { host, asked } = fakeHost();
		const { chips } = await mount('[a.zip](a.zip)\n', host);
		const link = chips()[0]?.querySelector('[role="link"]');

		link?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		link?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		link?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
		link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(asked).toEqual(['a.zip', 'a.zip', 'a.zip']);
	});

	it('opens on Enter while selected, rather than splitting the paragraph around it', async () => {
		const { host, asked } = fakeHost();
		const mounted = await mount('A [a.zip](a.zip) b.\n', host);
		selectChip(mounted);
		const before = mounted.view.state.doc;

		const enter = (init: KeyboardEventInit) =>
			mounted.view.dom.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
					...init,
				})
			);
		enter({});

		expect(asked).toEqual(['a.zip']);
		expect(mounted.view.state.doc.eq(before)).toBe(true);
		// Mod+Enter is the task list's, wherever the selection is, and
		// Shift+Enter is a line break.
		enter({ ctrlKey: true });
		enter({ metaKey: true });
		enter({ shiftKey: true });
		expect(asked).toEqual(['a.zip']);
	});

	it('leaves Enter alone anywhere but on a chip, a picture selected whole included', async () => {
		const { host, asked } = fakeHost();
		const { view } = await mount('A [a.zip](a.zip) ![b](b.png) c.\n', host);
		const enter = () =>
			view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
		enter();
		const picture = { current: -1 };
		view.state.doc.descendants((node, pos) => {
			if (node.type.name === 'image') picture.current = pos;
		});
		view.dispatch(
			view.state.tr.setSelection(NodeSelection.create(view.state.doc, picture.current))
		);
		enter();

		expect(asked).toEqual([]);
	});

	it('is taken out of the note by Remove, as an edit, leaving the words around it', async () => {
		const mounted = await mount('A [a.zip](a.zip) b.\n');
		selectChip(mounted);

		mounted
			.chips()[0]
			?.querySelector<HTMLButtonElement>('[aria-label="Remove from note"]')
			?.click();

		expect(mounted.chips()).toEqual([]);
		expect(mounted.onUserEdit).toHaveBeenLastCalledWith('A  b.\n');
	});

	it('keeps a key pressed in its bar from the editor', async () => {
		const { host } = fakeHost();
		const mounted = await mount('A [a.zip](a.zip) b.\n', host);
		selectChip(mounted);
		const before = mounted.view.state.doc;

		mounted
			.chips()[0]
			?.querySelector('[aria-label="Remove from note"]')
			?.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);

		expect(mounted.view.state.doc.eq(before)).toBe(true);
	});

	it('says what its new words say', async () => {
		const mounted = await mount('A [a.zip](a.zip) b.\n');
		const at = mounted.chipAt();

		mounted.view.dispatch(
			mounted.view.state.tr.setNodeMarkup(at, undefined, {
				href: 'b.mp3',
				title: null,
				label: 'Interview',
			})
		);

		const link = mounted.chips()[0]?.querySelector('[role="link"]');
		expect(link?.getAttribute('aria-label')).toBe('Interview, Audio');
	});
});

describe('a chip on the clipboard', () => {
	it('is copied out as its name, with no link a page could follow, and read back as itself', async () => {
		const { view } = await mount('A [Q3.pdf](q3.pdf "t") b.\n');
		const type = view.state.schema.nodes.attachment;
		if (type === undefined) throw new Error('No attachment node');

		const dom = DOMSerializer.fromSchema(view.state.schema).serializeNode(
			type.create({ href: 'q3.pdf', title: 't', label: 'Q3.pdf' })
		);
		expect(dom instanceof Element && dom.outerHTML).toBe(
			'<a data-attachment="q3.pdf" title="t">Q3.pdf</a>'
		);

		const holder = document.createElement('div');
		holder.innerHTML =
			'<p><a data-attachment="q3.pdf" title="t">Q3.pdf</a> <a data-attachment="https://x/a.pdf">a</a></p>';
		const names: unknown[] = [];
		ProseParser.fromSchema(view.state.schema)
			.parse(holder)
			.descendants((node) => {
				if (node.type.name === 'attachment') names.push(node.attrs);
			});
		expect(names).toEqual([{ href: 'q3.pdf', title: 't', label: 'Q3.pdf' }]);
	});
});
