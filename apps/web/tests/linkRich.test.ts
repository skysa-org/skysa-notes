import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { linkAt } from '../src/editor/linkRich.js';
import { linksOpened as opened } from './linksOpened.js';
import { destroyRichEditors, mountRich } from './support/editor.js';

/**
 * A link in rich text, opened in the browser (docs/ARCHITECTURE.md §7,
 * "Links open in the browser"): the chip under the link the cursor is in,
 * Cmd- or Ctrl-click, and Alt+Enter — none of them an edit.
 */

const cleanups: (() => void)[] = [];

afterEach(async () => {
	cleanups.splice(0).forEach((cleanup) => {
		cleanup();
	});
	await destroyRichEditors();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const mount = async (body: string) => {
	const onUserEdit = vi.fn();
	const { editor, root } = await mountRich({ body, onUserEdit });
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	view.focus();
	const chip = () => root.querySelector<HTMLElement>('.link-chip');
	return { view, root, onUserEdit, chip };
};

/** Where `text` starts in the document, plus `offset`. */
const at = (view: EditorView, text: string, offset = 0): number => {
	const found = { current: -1 };
	view.state.doc.descendants((node, pos) => {
		if (found.current !== -1 || !node.isText) return;
		const index = node.text?.indexOf(text) ?? -1;
		if (index !== -1) found.current = pos + index + offset;
	});
	if (found.current === -1) throw new Error(`no "${text}"`);
	return found.current;
};

const cursorAt = (view: EditorView, pos: number) => {
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
};

const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	view.dom.dispatchEvent(event);
	return event;
};

describe('the link a cursor is in', () => {
	it('runs across its words however they are set, from either end and inside', async () => {
		const { view } = await mount('See [the **bay** map](https://example.com/bay) today\n');
		const from = at(view, 'the ');
		const to = at(view, ' map', 4);
		for (const pos of [from, at(view, 'bay', 1), to]) {
			cursorAt(view, pos);
			expect(linkAt(view.state)).toEqual({ from, to, href: 'https://example.com/bay' });
		}
		cursorAt(view, at(view, 'See', 1));
		expect(linkAt(view.state)).toBeUndefined();
	});

	it('is nothing for a selection', async () => {
		const { view } = await mount('[a link](https://example.com)\n');
		view.dispatch(
			view.state.tr.setSelection(
				TextSelection.create(view.state.doc, at(view, 'a link'), at(view, 'a link', 3))
			)
		);
		expect(linkAt(view.state)).toBeUndefined();
	});
});

describe('the chip', () => {
	it('shows where the link the cursor is in goes, and only then', async () => {
		const { view, chip } = await mount('Plan: [the map](https://www.example.com/bay)\n');
		expect(chip()?.hidden).toBe(true);

		cursorAt(view, at(view, 'map', 1));
		expect(chip()?.hidden).toBe(false);
		expect(chip()?.querySelector('.link-chip-address')?.textContent).toBe('example.com/bay');
		expect(chip()?.querySelector('button')?.getAttribute('aria-label')).toBe(
			'Open example.com/bay'
		);

		cursorAt(view, at(view, 'Plan', 2));
		expect(chip()?.hidden).toBe(true);
	});

	it('is beside the text, not in it', async () => {
		const { view, chip } = await mount('[the map](https://example.com)\n');
		cursorAt(view, at(view, 'map', 1));
		expect(view.dom.contains(chip())).toBe(false);
		expect(chip()?.parentElement).toBe(view.dom.parentElement);
	});

	it('is not there for a link this app does not open', async () => {
		const { view, chip } = await mount(
			'[a note](other.md), [a script](javascript:alert(1)) and [a heading](#top)\n'
		);
		for (const words of ['a note', 'a script', 'a heading']) {
			cursorAt(view, at(view, words, 2));
			expect(chip()?.hidden, words).toBe(true);
		}
	});

	it('opens the link when pressed, and that is no edit', async () => {
		const seen = opened();
		const { view, chip, onUserEdit } = await mount('[the map](https://example.com/bay)\n');
		const dispatch = vi.spyOn(view, 'dispatch');
		cursorAt(view, at(view, 'map', 1));
		dispatch.mockClear();

		chip()?.querySelector('button')?.click();
		expect(seen).toEqual(['https://example.com/bay']);
		expect(dispatch).not.toHaveBeenCalled();
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('says where the link goes now, once its address is changed', async () => {
		const { view, chip } = await mount('[the map](https://example.com/old)\n');
		const pos = at(view, 'map', 1);
		cursorAt(view, pos);
		const type = view.state.schema.marks.link;
		if (type === undefined) throw new Error('no link mark');
		const from = at(view, 'the map');
		view.dispatch(
			view.state.tr.addMark(
				from,
				from + 'the map'.length,
				type.create({ href: 'https://example.com/new' })
			)
		);
		expect(chip()?.querySelector('.link-chip-address')?.textContent).toBe('example.com/new');
	});

	it('goes with the editor', async () => {
		const { root } = await mount('[the map](https://example.com)\n');
		await destroyRichEditors();
		expect(root.querySelector('.link-chip')).toBeNull();
	});
});

describe('a click with Cmd or Ctrl held', () => {
	const mountClickable = async (body: string, words: string) => {
		const mounted = await mount(body);
		const pos = at(mounted.view, words, 1);
		// Where jsdom, which lays nothing out, cannot say what is under the pointer.
		// Inside the paragraph, which is what ProseMirror selects for Cmd-click.
		const inside = mounted.view.state.doc.resolve(pos).before(1);
		vi.spyOn(mounted.view, 'posAtCoords').mockReturnValue({ pos, inside });
		// A browser follows no link in the text being edited, and jsdom does.
		const following = (event: Event) => {
			event.preventDefault();
		};
		document.addEventListener('click', following);
		cleanups.push(() => {
			document.removeEventListener('click', following);
		});
		const click = (target: Element | null, held: MouseEventInit) => {
			['mousedown', 'mouseup', 'click'].forEach((type) => {
				target?.dispatchEvent(
					new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...held })
				);
			});
		};
		return { ...mounted, click };
	};

	it('opens the link it lands on, and selects nothing', async () => {
		const seen = opened();
		const { view, click, onUserEdit } = await mountClickable(
			'See [the map](https://example.com/bay) today\n',
			'map'
		);
		const anchor = view.dom.querySelector('a[href]');

		click(anchor, { metaKey: true });
		click(anchor, { ctrlKey: true });

		expect(seen).toEqual(['https://example.com/bay', 'https://example.com/bay']);
		// The browser's own answer to the click is turned down, before the
		// event is past the editor.
		const refused: boolean[] = [];
		view.dom.parentElement?.addEventListener('click', (event) => {
			refused.push(event.defaultPrevented);
		});
		click(anchor, { metaKey: true });
		expect(refused).toEqual([true]);
		// ProseMirror's own answer to the modifier is to select the paragraph
		// around the click, which the next key typed would replace.
		expect(view.state.selection).toBeInstanceOf(TextSelection);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('leaves a plain click to put the cursor there', async () => {
		const seen = opened();
		const { view, click } = await mountClickable('[the map](https://example.com/bay)\n', 'map');
		click(view.dom.querySelector('a[href]'), {});
		expect(seen).toEqual([]);
	});

	it('leaves a link this app does not open to ProseMirror', async () => {
		const seen = opened();
		const { view, click } = await mountClickable('[a note](other.md)\n', 'note');
		click(view.dom.querySelector('a'), { metaKey: true });
		expect(seen).toEqual([]);
	});
});

describe('Alt+Enter', () => {
	it('opens the link the cursor is in, rather than splitting the paragraph', async () => {
		const seen = opened();
		const { view, onUserEdit } = await mount('[the map](https://example.com/bay)\n');
		cursorAt(view, at(view, 'map', 1));
		const event = press(view, 'Enter', { altKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(seen).toEqual(['https://example.com/bay']);
		expect(view.state.doc.childCount).toBe(1);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('is left alone outside a link', async () => {
		const seen = opened();
		const { view } = await mount('Plain words\n');
		cursorAt(view, at(view, 'words', 1));
		press(view, 'Enter', { altKey: true });
		expect(seen).toEqual([]);
	});
});
