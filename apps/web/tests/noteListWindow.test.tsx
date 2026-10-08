import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteList, WINDOWED_ABOVE } from '../src/components/NoteList.js';
import { type NoteRecord } from '../src/store/db.js';

/**
 * A long list draws only its rows near the screen (#275; docs/ARCHITECTURE.md
 * §7, "Large libraries"), and the rows the user is at wherever they are. jsdom
 * lays nothing out, so each test says how tall the screen is and how far the
 * list is scrolled, as a browser would.
 */

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document.documentElement, 'clientHeight');
});

/** The screen's height, and the pane's header over the rows. */
const SCREEN = 640;
const HEADER = 40;

/** A row's height before any is measured (`ROW_GUESS`). */
const GUESS = 64;

const note = (at: number, folder = 'work'): NoteRecord =>
	({
		id: `n${String(at)}`,
		title: `Note ${String(at)}`,
		body: '',
		path: `${folder}/Note ${String(at)}.md`,
		updatedAt: 0,
		dirty: 0,
	}) as NoteRecord;

const notesOf = (count: number, folder = 'work', from = 0) =>
	Array.from({ length: count }, (_, at) => note(from + at, folder));

const listProps = (notes: readonly NoteRecord[]) => ({
	notes: [...notes],
	selectedNoteId: undefined,
	onSelectNote: () => undefined,
	onCreateNote: () => undefined,
	folderPath: 'work',
	storeLoaded: true,
});

const scroller = () => {
	const pane = document.querySelector('.note-list');
	if (!(pane instanceof HTMLElement)) throw new Error('no list');
	return pane;
};

/**
 * Lays the page out, and the list `height` tall, `SCREEN` unless said, and
 * scrolls it to `to`: the rows' top is then that far above the screen's,
 * under the header.
 */
const scrollTo = (to: number, height = SCREEN) => {
	const pane = scroller();
	const rows = pane.querySelector('.note-rows');
	if (!(rows instanceof HTMLElement)) throw new Error('no rows');
	Object.defineProperty(document.documentElement, 'clientHeight', {
		configurable: true,
		value: 844,
	});
	Object.defineProperty(pane, 'clientHeight', { configurable: true, value: height });
	vi.spyOn(rows, 'getBoundingClientRect').mockReturnValue(
		DOMRect.fromRect({ x: 0, y: HEADER - to, width: 300, height: 0 })
	);
	act(() => {
		pane.dispatchEvent(new Event('scroll'));
	});
};

const drawn = () =>
	[...document.querySelectorAll('li.row-item')].map(
		(item) => item.querySelector('.note-title')?.textContent ?? ''
	);

/** A row's own button, which its title begins the name of. */
const rowButton = (title: string) => {
	const button = screen.getByText(title).closest('button');
	if (button === null) throw new Error(`no row ${title}`);
	return button;
};

const skipped = () =>
	[...document.querySelectorAll<HTMLElement>('.rows-skipped')].map((gap) =>
		Number.parseFloat(gap.style.height)
	);

describe('a long note list', () => {
	it('draws every row of a list of 150 or fewer, as it always has, and not of 151', () => {
		expect(WINDOWED_ABOVE).toBe(150);
		const { rerender } = render(<NoteList {...listProps(notesOf(150))} />);
		scrollTo(0);

		expect(drawn()).toHaveLength(150);
		expect(skipped()).toEqual([]);
		expect(document.querySelector('[aria-setsize]')).toBeNull();

		rerender(<NoteList {...listProps(notesOf(151))} />);
		scrollTo(0);
		expect(drawn().length).toBeLessThan(151);
	});

	it('draws every row where nothing is laid out', () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		expect(drawn()).toHaveLength(300);
	});

	it('draws only the rows near the screen of a longer list, and the room the others take', () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(0);

		const rows = drawn();
		// The screen and a screen under it, at the guessed height.
		expect(rows.length).toBeGreaterThanOrEqual((2 * SCREEN) / GUESS);
		expect(rows.length).toBeLessThan((3 * SCREEN) / GUESS);
		expect(rows[0]).toBe('Note 0');
		expect(skipped()).toEqual([(300 - rows.length) * GUESS]);
		// Said to be one of all of them.
		const first = document.querySelector('li.row-item');
		expect(first?.getAttribute('aria-setsize')).toBe('300');
		expect(first?.getAttribute('aria-posinset')).toBe('1');
	});

	it('keeps the rows it drew while the list is hidden, behind the note open beside it', () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(150 * GUESS);
		const rows = drawn();

		// A phone's list, its pane shut while a note is read.
		scrollTo(150 * GUESS, 0);
		expect(drawn()).toEqual(rows);
	});

	it('draws only its first screens when it is hidden from the start, its first draw too', () => {
		Object.defineProperty(document.documentElement, 'clientHeight', {
			configurable: true,
			value: 844,
		});
		// Every row ever made, before it could be measured as well.
		const made = vi.spyOn(document, 'createElement');
		render(<NoteList {...listProps(notesOf(300))} />);
		const rowsMade = made.mock.calls.filter(([tag]) => tag === 'li').length;
		made.mockRestore();

		const rows = drawn();
		expect(rows[0]).toBe('Note 0');
		expect(rows.length).toBeLessThan(60);
		expect(rowsMade).toBeLessThan(60);
	});

	it('draws again only once the screen has moved a quarter of its height', () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(200);
		const rows = drawn();

		scrollTo(300);
		expect(drawn()).toEqual(rows);

		scrollTo(360);
		expect(drawn()).not.toEqual(rows);
	});

	it('draws the rows scrolled to, and lets go of those scrolled away from', () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(150 * GUESS);

		const rows = drawn();
		expect(rows).toContain('Note 150');
		expect(rows).toContain('Note 160');
		expect(rows).not.toContain('Note 0');
		expect(rows).not.toContain('Note 299');
		const [above = 0, below = 0] = skipped();
		expect(above + below + rows.length * GUESS).toBe(300 * GUESS);
		const at150 = screen.getByText('Note 150').closest('li');
		expect(at150?.getAttribute('aria-posinset')).toBe('151');
	});

	it('keeps the selected row drawn wherever it is', () => {
		render(<NoteList {...listProps(notesOf(300))} selectedNoteId="n250" />);
		scrollTo(0);

		expect(drawn()).toContain('Note 250');
		expect(drawn()).not.toContain('Note 249');
		// The rows either side of it are room, so it is where it would be.
		const [before = 0, after = 0] = skipped();
		expect(before).toBe((250 - drawn().length + 1) * GUESS);
		expect(after).toBe(49 * GUESS);
	});

	it('keeps the row the focus is in drawn while it is scrolled away from, and the rows either side', async () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(0);
		const row = rowButton('Note 1');
		act(() => {
			row.focus();
		});

		scrollTo(200 * GUESS);
		expect(drawn().slice(0, 3)).toEqual(['Note 0', 'Note 1', 'Note 2']);
		expect(drawn()).not.toContain('Note 3');

		act(() => {
			row.blur();
		});
		await waitFor(() => {
			expect(drawn()).not.toContain('Note 1');
		});
		expect(drawn()).not.toContain('Note 0');
	});

	it('goes with Tab and Shift+Tab from the focused row to the rows either side, scrolled away from', async () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(0);
		act(() => {
			rowButton('Note 1').focus();
		});
		scrollTo(200 * GUESS);

		await userEvent.tab();
		expect(document.activeElement).toBe(rowButton('Note 2'));
		await userEvent.tab();
		expect(document.activeElement).toBe(rowButton('Note 3'));
		await userEvent.tab({ shift: true });
		await userEvent.tab({ shift: true });
		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(rowButton('Note 0'));
		expect(drawn()).not.toContain('Note 3');
	});

	it('keeps the row drawn while the focus moves within it, from its button to its options', async () => {
		render(
			<NoteList
				{...listProps(notesOf(300))}
				menuFor={() => [{ label: 'Pin', onChoose: () => undefined }]}
			/>
		);
		scrollTo(0);
		act(() => {
			rowButton('Note 4').focus();
		});
		scrollTo(200 * GUESS);

		// A browser's blur is drawn before the focus lands: React draws it in
		// a microtask, which runs between the two.
		act(() => {
			rowButton('Note 4').blur();
		});
		expect(drawn()).toContain('Note 4');
		const options = screen.getByRole('button', { name: 'Options for “Note 4”' });
		act(() => {
			options.focus();
		});
		await new Promise((settled) => setTimeout(settled, 10));
		expect(drawn()).toContain('Note 4');
		expect(document.activeElement).toBe(options);
	});

	it('keeps the row the focus is in when the window loses the focus, not the row', async () => {
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(0);
		const row = rowButton('Note 1');
		act(() => {
			row.focus();
		});
		scrollTo(200 * GUESS);

		// Another window takes the focus: the row keeps it, and is told it went.
		const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
		try {
			act(() => {
				row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
			});
			await new Promise((settled) => setTimeout(settled, 10));
			expect(drawn()).toContain('Note 1');
			expect(document.activeElement).toBe(row);
		} finally {
			hasFocus.mockRestore();
		}
	});

	it('keeps the row the focus is in when a sync takes the list past 150', () => {
		const { rerender } = render(<NoteList {...listProps(notesOf(150))} />);
		scrollTo(0);
		act(() => {
			rowButton('Note 1').focus();
		});

		rerender(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(200 * GUESS);
		expect(drawn()).toContain('Note 1');
		expect(drawn()).not.toContain('Note 3');
	});

	it('keeps the row being moved drawn', () => {
		const { rerender } = render(<NoteList {...listProps(notesOf(300))} movingNoteId="n3" />);
		scrollTo(200 * GUESS);
		expect(drawn()).toContain('Note 3');

		rerender(<NoteList {...listProps(notesOf(300))} />);
		expect(drawn()).not.toContain('Note 3');
	});

	it('keeps the row drawn while the focus is in its menu', async () => {
		render(
			<NoteList
				{...listProps(notesOf(300))}
				menuFor={() => [{ label: 'Pin', onChoose: () => undefined }]}
			/>
		);
		scrollTo(0);
		const options = screen.getByRole('button', { name: 'Options for “Note 4”' });
		await userEvent.click(options);
		const item = await screen.findByRole('button', { name: 'Pin' });
		act(() => {
			item.focus();
		});

		scrollTo(200 * GUESS);
		expect(drawn()).toContain('Note 4');
	});

	it('stands in for a notebook inside the open one, its name too, while all of it is off screen', () => {
		render(<NoteList {...listProps([...notesOf(200), ...notesOf(100, 'work/Later', 200)])} />);
		scrollTo(0);

		expect(screen.queryByRole('heading', { name: 'Later' })).toBeNull();
		expect(document.querySelectorAll('div.rows-skipped')).toHaveLength(1);

		// And the open notebook's own rows, all of them scrolled past, are room.
		scrollTo(260 * GUESS);
		expect(screen.getByRole('heading', { name: 'Later' })).toBeDefined();
		expect(drawn()).toContain('Note 260');
		const gaps = document.querySelectorAll('div.rows-skipped');
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.matches('.note-rows > :first-child')).toBe(true);
		expect(Number.parseFloat((gaps[0] as HTMLElement).style.height)).toBe(200 * GUESS);
	});

	it('places the rows by their heights as measured, and the rest as tall as those', () => {
		const observed: Element[] = [];
		// The list's observers, one for its rows and one for its notebooks' names.
		const told: ResizeObserverCallback[] = [];
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(callback: ResizeObserverCallback) {
					told.push(callback);
				}
				observe(element: Element) {
					observed.push(element);
				}
				unobserve() {
					return undefined;
				}
				disconnect() {
					return undefined;
				}
			}
		);
		render(<NoteList {...listProps(notesOf(300))} />);
		scrollTo(0);
		const rows = [...document.querySelectorAll('li.row-item')];
		expect(rows.every((row) => observed.includes(row))).toBe(true);

		const entries = rows.map(
			(target) =>
				({ target, borderBoxSize: [{ blockSize: 80 }] }) as unknown as ResizeObserverEntry
		);
		act(() => {
			for (const callback of told) callback(entries, {} as ResizeObserver);
		});
		// Fewer rows meet the screen, each being taller.
		expect(drawn().length).toBeLessThan(rows.length);
		const [below = 0] = skipped();
		expect(below).toBe((300 - drawn().length) * 80);

		// A phone's list, hidden behind the note open beside it: every row
		// it has is then 0 tall, and is not taken to be.
		const measured = drawn();
		scrollTo(0, 0);
		const hidden = [...document.querySelectorAll('li.row-item')].map(
			(target) =>
				({ target, borderBoxSize: [{ blockSize: 0 }] }) as unknown as ResizeObserverEntry
		);
		act(() => {
			for (const callback of told) callback(hidden, {} as ResizeObserver);
		});
		expect(drawn()).toEqual(measured);
		expect(skipped()).toEqual([below]);
	});
});
