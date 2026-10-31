import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RawEditor } from '../src/editor/raw/RawEditor.js';
import { linksOpened as opened } from './linksOpened.js';

/**
 * A link in raw markdown, opened in the browser as in rich text
 * (docs/ARCHITECTURE.md §7, "Links open in the browser"): the chip under the
 * link the cursor is in, Cmd- or Ctrl-press, and Alt+Enter.
 */

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const mount = (body: string) => {
	const onUserEdit = vi.fn();
	const { container } = render(<RawEditor noteId="a" body={body} onUserEdit={onUserEdit} />);
	const view = EditorView.findFromDOM(container);
	if (view === null) throw new Error('CodeMirror did not mount');
	/** The cursor, `offset` characters into the first `text`. */
	const cursorIn = (text: string, offset = 1) => {
		const index = body.indexOf(text);
		if (index === -1) throw new Error(`no "${text}"`);
		view.dispatch({ selection: EditorSelection.cursor(index + offset) });
	};
	const chip = () => container.querySelector<HTMLElement>('.link-chip');
	return { view, onUserEdit, cursorIn, chip };
};

describe('the chip', () => {
	it.each([
		['a link', 'See [the map](https://example.com/bay) today\n', 'map', 'example.com/bay'],
		[
			'a link from its start',
			'[the map](https://example.com/bay)\n',
			'[the',
			'example.com/bay',
		],
		[
			'a link in its address',
			'[the map](https://example.com/bay)\n',
			'example',
			'example.com/bay',
		],
		[
			'an address in angle brackets',
			'[the map](<https://example.com/a b>)\n',
			'map',
			'example.com/a b',
		],
		['an autolink', 'Go to <https://example.com/a> now\n', 'example', 'example.com/a'],
		['an e-mail autolink', 'Write to <ann@example.com>\n', 'ann', 'ann@example.com'],
		['a bare address', 'Go to https://example.com/b now\n', 'example', 'example.com/b'],
		['a bare www.', 'Go to www.example.com now\n', 'example', 'example.com'],
		['a bare e-mail address', 'Write to ann@example.com\n', 'ann', 'ann@example.com'],
	])('says where %s goes, with the cursor in it', (_, body, words, address) => {
		const { cursorIn, chip } = mount(body);
		cursorIn(words);
		expect(chip()?.querySelector('.link-chip-address')?.textContent).toBe(address);
		expect(chip()?.querySelector('button')?.getAttribute('aria-label')).toBe(`Open ${address}`);
	});

	it.each([
		['a picture', '![the bay](https://example.com/bay.png)\n', 'bay'],
		['a reference', '[the map][1]\n\n[1]: https://example.com\n', 'map'],
		['a note beside this one', '[the plan](plan.md)\n', 'plan'],
		['a script', '[run me](javascript:alert(1))\n', 'run'],
		['words beside a link', 'Plain words and [a link](https://example.com)\n', 'Plain'],
	])('is not there for %s', (_, body, words) => {
		const { cursorIn, chip } = mount(body);
		cursorIn(words);
		expect(chip()).toBeNull();
	});

	it('is not there for a selection', () => {
		const { view, chip } = mount('[the map](https://example.com/bay)\n');
		view.dispatch({ selection: EditorSelection.range(1, 5) });
		expect(chip()).toBeNull();
	});

	it('opens the link when pressed, and that is no edit', () => {
		const seen = opened();
		const { cursorIn, chip, onUserEdit } = mount('[the map](https://example.com/bay)\n');
		cursorIn('map');
		chip()?.querySelector('button')?.click();
		expect(seen).toEqual(['https://example.com/bay']);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('is the same chip while the cursor moves inside the link, and a new one for another', () => {
		const { cursorIn, chip } = mount(
			'[one](https://example.com/1) and [two](https://example.com/2)\n'
		);
		cursorIn('one', 1);
		const first = chip();
		cursorIn('one', 2);
		expect(chip()).toBe(first);
		cursorIn('two');
		expect(chip()?.querySelector('.link-chip-address')?.textContent).toBe('example.com/2');
	});
});

describe('Alt+Enter', () => {
	const altEnter = (view: EditorView) => {
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			altKey: true,
			bubbles: true,
			cancelable: true,
		});
		view.contentDOM.dispatchEvent(event);
		return event;
	};

	it('opens the link the cursor is in, rather than breaking the line', () => {
		const seen = opened();
		const { view, cursorIn, onUserEdit } = mount('[the map](https://example.com/bay)\n');
		cursorIn('map');
		expect(altEnter(view).defaultPrevented).toBe(true);
		expect(seen).toEqual(['https://example.com/bay']);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('is left alone outside a link', () => {
		const seen = opened();
		const { view, cursorIn } = mount('Plain words\n');
		cursorIn('words');
		altEnter(view);
		expect(seen).toEqual([]);
	});
});

describe('a press with Cmd or Ctrl held', () => {
	const pressAt = (view: EditorView, pos: number, held: MouseEventInit) => {
		// Where jsdom, which lays nothing out, cannot say what is under the pointer.
		vi.spyOn(view, 'posAtCoords').mockReturnValue(pos);
		const event = new MouseEvent('mousedown', {
			bubbles: true,
			cancelable: true,
			button: 0,
			...held,
		});
		view.contentDOM.dispatchEvent(event);
		return event;
	};

	it('opens the link it lands on, and adds no cursor there', () => {
		const seen = opened();
		const { view } = mount('See [the map](https://example.com/bay) today\n');
		expect(pressAt(view, 8, { metaKey: true }).defaultPrevented).toBe(true);
		pressAt(view, 8, { ctrlKey: true });
		expect(seen).toEqual(['https://example.com/bay', 'https://example.com/bay']);
		expect(view.state.selection.ranges).toHaveLength(1);
	});

	it('leaves a plain press, and a press beside a link, to CodeMirror', () => {
		const seen = opened();
		const { view } = mount('See [the map](https://example.com/bay) today\n');
		pressAt(view, 8, {});
		pressAt(view, 1, { metaKey: true });
		expect(seen).toEqual([]);
	});
});
