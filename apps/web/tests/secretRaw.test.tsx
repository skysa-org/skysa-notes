import { isolateHistory, undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RawEditor } from '../src/editor/RawEditor.js';
import { NO_SECRETS, type Opened, type SecretHost } from '../src/editor/secretHost.js';
import { allSecrets } from '../src/editor/secretRaw.js';
import { fakeHost, fence, openedIn, sealed, sealedForAnother } from './secretHostFake.js';

/**
 * A secret in raw mode (docs/ARCHITECTURE.md §7, "Secrets in a note"): its
 * armor as written, Reveal on its opening line, and its words in the same
 * panel as in rich mode, outside the text, the text changed only where the
 * words did, as they are typed, as the user's edit.
 */

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const mount = (body: string, host: SecretHost = NO_SECRETS) => {
	const onUserEdit = vi.fn();
	const props = { noteId: 'a', onUserEdit, secrets: host };
	const { container, rerender, unmount } = render(
		<RawEditor {...props} body={body} origin={body} />
	);
	const view = EditorView.findFromDOM(container);
	if (view === null) throw new Error('CodeMirror did not mount');
	const text = () => view.state.doc.toString();
	const field = () => container.querySelector<HTMLTextAreaElement>('.secret-words');
	const button = (name: string) =>
		[...container.querySelectorAll<HTMLButtonElement>('button')].find(
			(each) => each.textContent === name && !each.hidden
		);
	const press = (name: string) => {
		const found = button(name);
		if (found === undefined) throw new Error(`no ${name} button`);
		found.click();
	};
	/**
	 * `words` in the field, as typing them leaves it: the caret at `caret`, or
	 * at the end; `composing`, as an input method is mid-character.
	 */
	const type = (
		words: string,
		{ caret = words.length, composing = false }: { caret?: number; composing?: boolean } = {}
	) => {
		const into = field();
		if (into === null) throw new Error('no panel');
		into.value = words;
		into.setSelectionRange(caret, caret);
		into.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
	};
	const revealed = async (words?: string) => {
		press('Reveal');
		await vi.waitFor(() => {
			expect(field()).not.toBeNull();
		});
		if (words !== undefined) expect(field()?.value).toBe(words);
	};
	/** A new secret begun at `at`, its panel open. */
	const inserted = async (insert: () => void, at: number) => {
		view.dispatch({ selection: EditorSelection.cursor(at) });
		insert();
		await vi.waitFor(() => {
			expect(field()).not.toBeNull();
		});
	};
	/** A body from outside — a pull — adopted as the app's change. */
	const pulled = (next: string) => {
		rerender(<RawEditor {...props} body={next} origin={next} />);
	};
	return {
		view,
		container,
		onUserEdit,
		text,
		field,
		button,
		press,
		type,
		revealed,
		inserted,
		pulled,
		unmount,
		/** The words each secret in the note opens to, in order. */
		opened: () => openedIn(text()),
		/** The words each secret opens to in the last text the editor reported as the user's. */
		reported: () => openedIn(String(onUserEdit.mock.lastCall?.[0] ?? '')),
	};
};

/** Whether `target` is taken out of `container` while watched. */
const watchRemoval = (container: HTMLElement, target: Element | null) => {
	const removed = vi.fn();
	const watching = new MutationObserver((records) => {
		if (
			records.some((record) =>
				[...record.removedNodes].some((node) => target !== null && node.contains(target))
			)
		)
			removed();
	});
	watching.observe(container, { childList: true, subtree: true });
	return {
		removed,
		stop: () => {
			watching.disconnect();
		},
	};
};

/** How many undos take the editor back to `body`. */
const undosTo = (view: EditorView, body: string): number => {
	const undone = { count: 0 };
	while (view.state.doc.toString() !== body && undone.count < 20 && undo(view)) {
		undone.count += 1;
	}
	return undone.count;
};

describe('a secret in raw mode', () => {
	it('shows its armor as written, with Reveal on its opening line', () => {
		const armor = sealed('the door code');
		const body = `Front:\n\n${fence(armor)}\n\nBack.\n`;
		const h = mount(body, fakeHost().host);

		const line = h.container.querySelector('.secret-reveal')?.closest('.cm-line');
		expect(line?.textContent).toMatch(/^```age/u);
		expect(h.text()).toBe(body);
	});

	it('offers nothing on a fence that says age and holds something else', () => {
		const h = mount('```age\nage -d -i key.txt secret.age\n```\n', fakeHost().host);

		expect(h.button('Reveal')).toBeUndefined();
	});

	it('reveals its words under the fence, outside the text, and Cancel changes nothing', async () => {
		const armor = sealed('the door code');
		const body = `${fence(armor)}\n\nBack.\n`;
		const h = mount(body, fakeHost().host);

		await h.revealed('the door code');

		const panel = h.container.querySelector('.secret-panel');
		expect(panel?.closest('.cm-line')).toBeNull();
		expect(document.activeElement).toBe(h.field());
		expect(h.text()).toBe(body);
		expect(h.button('Reveal')).toBeUndefined();
		h.press('Cancel');
		expect(h.field()).toBeNull();
		expect(h.button('Reveal')).toBeDefined();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.text()).toBe(body);
	});

	it('keeps the armor byte for byte where the words come back to what they were', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();

		h.type('the door code');
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(fake.seal).not.toHaveBeenCalled();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.text()).toBe(`${fence(armor)}\n`);
	});

	it('keeps words as they are typed, in the armor’s place, the panel and its caret where they were', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = mount(`Front:\n\n${fence(armor)}\n\nBack.\n`, fake.host);
		await h.revealed();
		const field = h.field();
		const removed = vi.fn();
		const watching = new MutationObserver((records) => {
			if (
				records.some((record) =>
					[...record.removedNodes].some((node) => node.contains(field))
				)
			)
				removed();
		});
		watching.observe(h.container, { childList: true, subtree: true });

		h.type('the new door code', { caret: 4 });
		h.type('the newer door code', { caret: 9 });
		await Promise.resolve();
		watching.disconnect();

		expect(fake.seal).toHaveBeenCalledTimes(2);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
		expect(h.reported()).toEqual(['the newer door code']);
		expect(h.text()).not.toContain(armor);
		expect(h.text()).toMatch(/^Front:\n\n```age\n[\s\S]+\n```\n\nBack\.\n$/u);
		expect(removed).not.toHaveBeenCalled();
		expect(h.field()).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe(9);
		expect(h.button('Reveal')).toBeUndefined();

		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['the newer door code']);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('puts the armor back with Cancel, after it was typed in', async () => {
		const armor = sealed('the door code');
		const h = mount(`${fence(armor)}\n`, fakeHost().host);
		await h.revealed();
		h.type('typed, then cancelled');
		expect(h.opened()).toEqual(['typed, then cancelled']);

		h.press('Cancel');

		expect(h.field()).toBeNull();
		expect(h.text()).toBe(`${fence(armor)}\n`);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('joins the words typed into one step of the history, as typing in the note does', async () => {
		const body = `Front.\n\n${fence(sealed('one'))}\n`;
		const h = mount(body, fakeHost().host);
		await h.revealed();
		['one,', 'one, t', 'one, tw', 'one, two', 'one, two!'].forEach((words) => {
			h.type(words);
		});
		h.press('Done');

		expect(undosTo(h.view, body)).toBe(1);
	});

	it('makes a new secret a step of its own in the history, apart from what was typed just before', async () => {
		const fake = fakeHost();
		const h = mount('First line\n', fake.host);
		h.view.dispatch({
			changes: { from: 10, insert: '!' },
			selection: EditorSelection.cursor(11),
			userEvent: 'input.type',
		});
		const typed = h.text();
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		['n', 'ne', 'new'].forEach((words) => {
			h.type(words);
		});
		h.press('Done');

		expect(undosTo(h.view, typed)).toBe(1);
		expect(h.text()).toBe(typed);
	});

	it('keeps the lines around a new secret apart with Cancel, where the quote’s mark under it was taken out', async () => {
		const fake = fakeHost();
		const h = mount('> # A\n> b\n', fake.host);
		await h.inserted(fake.insert, 4);
		h.type('words');
		const [secret] = allSecrets(h.view.state);
		if (secret === undefined) throw new Error('not written');
		expect(h.view.state.sliceDoc(secret.end, secret.end + 2)).toBe('\n>');
		h.view.dispatch({ changes: { from: secret.end + 1, to: secret.end + 2 } });

		h.press('Cancel');

		expect(h.opened()).toEqual([]);
		expect(h.text().split('\n')).toEqual(expect.arrayContaining(['> # A', '> b']));
	});

	it('puts back exactly what was there with Cancel, in a list, a blank line in its fence', async () => {
		const armor = sealed('listed');
		const body = `- item\n\n  \`\`\`age\n  ${armor.split('\n').join('\n  ')}\n\n  \`\`\`\n`;
		const h = mount(body, fakeHost().host);
		await h.revealed('listed');
		h.type('changed');

		h.press('Cancel');

		expect(h.text()).toBe(body);
	});

	it('keeps a character an input method is composing as it ends', async () => {
		const armor = sealed('one');
		const h = mount(`${fence(armor)}\n`, fakeHost().host);
		await h.revealed();

		h.type('oneあ', { composing: true });
		expect(h.onUserEdit).not.toHaveBeenCalled();
		h.field()?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));

		expect(h.opened()).toEqual(['oneあ']);
	});

	it('writes new armor inside the list the secret is in', async () => {
		const armor = sealed('listed');
		const indented = armor.split('\n').join('\n  ');
		const h = mount(`- item\n\n  \`\`\`age\n  ${indented}\n  \`\`\`\n`, fakeHost().host);
		await h.revealed('listed');

		h.type('still listed');
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.text()).toMatch(
			/^- item\n\n {2}```age\n {2}-----BEGIN[^\n]+(\n {2}[^\n]+)+\n {2}```\n$/u
		);
		const [, inner] = /```age\n([\s\S]*?)\n {2}```/u.exec(h.text()) ?? [];
		expect(
			openedIn(`\`\`\`age\n${inner?.replaceAll('\n  ', '\n').trim() ?? ''}\n\`\`\``)
		).toEqual(['still listed']);
	});

	it('reveals with Alt+Enter from inside the fence', async () => {
		const armor = sealed('by key');
		const body = `${fence(armor)}\n`;
		const h = mount(body, fakeHost().host);
		h.view.dispatch({ selection: EditorSelection.cursor(body.indexOf('BEGIN')) });

		h.view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true })
		);

		await vi.waitFor(() => {
			expect(h.field()?.value).toBe('by key');
		});
	});

	it('keeps its Reveal as it was pressed while the secret opens, the note typed in meanwhile', async () => {
		const fake = fakeHost();
		const opening = Promise.withResolvers<Opened>();
		vi.mocked(fake.host.open).mockReturnValueOnce(opening.promise);
		const body = `${fence(sealed('the door code'))}\n\nBack.\n`;
		const h = mount(body, fake.host);
		const reveal = h.button('Reveal');

		h.press('Reveal');
		h.view.dispatch({
			changes: { from: body.length, insert: 'More.\n' },
			userEvent: 'input.type',
		});

		expect(h.button('Reveal')).toBe(reveal);
		expect(reveal?.disabled).toBe(true);
		opening.resolve({ state: 'opened', words: 'the door code', seal: fake.seal });
		await vi.waitFor(() => {
			expect(h.field()?.value).toBe('the door code');
		});
	});

	it('keeps the keys pressed in its panel from the note', async () => {
		const body = `Before.\n\n${fence(sealed('the door code'))}\n`;
		const h = mount(body, fakeHost().host);
		h.view.dispatch({ selection: EditorSelection.cursor(7) });
		await h.revealed();

		h.field()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
		h.field()?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true })
		);

		expect(h.text()).toBe(body);
	});

	it('shows one panel for a secret that is in the note twice, under the first', async () => {
		const armor = sealed('twice');
		const h = mount(`${fence(armor)}\n\n${fence(armor)}\n`, fakeHost().host);
		await h.revealed('twice');
		const field = h.field();

		expect(h.container.querySelectorAll('.secret-reveal:not([hidden])')).toHaveLength(1);
		h.press('Reveal');
		await Promise.resolve();

		expect(h.container.querySelectorAll('.secret-words')).toHaveLength(1);
		expect(document.activeElement).toBe(field);
		// Under the first: before the second's armor begins.
		const holder = h.container.querySelector('.secret-raw-panel') ?? h.view.contentDOM;
		expect(h.view.posAtDOM(holder)).toBeLessThan(h.text().lastIndexOf(armor));
	});

	it('says why a secret will not reveal', async () => {
		const h = mount(`${fence(sealedForAnother('theirs'))}\n`, fakeHost().host);

		h.press('Reveal');

		await vi.waitFor(() => {
			expect(h.container.querySelector('.secret-note')?.textContent).toBe(
				'This secret was made with a different key, which this device does not have.'
			);
		});
		expect(h.field()).toBeNull();
	});

	it('says nothing more of why once Reveal is pressed again', async () => {
		const fake = fakeHost();
		vi.mocked(fake.host.open)
			.mockResolvedValueOnce({ state: 'other' })
			.mockResolvedValueOnce({ state: 'locked' });
		const h = mount(`${fence(sealed('mine'))}\n`, fake.host);
		const note = () => h.container.querySelector('.secret-note')?.textContent;
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(note()).not.toBe('');
		});

		h.press('Reveal');

		expect(note()).toBe('');
		await vi.waitFor(() => {
			expect(fake.host.open).toHaveBeenCalledTimes(2);
		});
		expect(h.field()).toBeNull();
	});
});

describe('inserting a secret in raw mode', () => {
	it('opens an empty panel under the cursor’s line, and inserts nothing where nothing is typed', async () => {
		const fake = fakeHost();
		const body = 'First line\n\nSecond line\n';
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, 3);

		const panelLine = h.container.querySelector('.secret-raw-panel')?.previousElementSibling;
		expect(panelLine?.textContent).toBe('First line');
		expect(document.activeElement).toBe(h.field());
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.text()).toBe(body);
		expect(h.onUserEdit).not.toHaveBeenCalled();
	});

	it('puts its first words in as a fence of its own after the cursor’s line, the panel moving under it', async () => {
		const fake = fakeHost();
		const h = mount('First line\n\nSecond line\n', fake.host);
		await h.inserted(fake.insert, 3);
		const field = h.field();

		h.type('a new secret', { caret: 5 });
		await Promise.resolve();

		expect(h.text()).toMatch(/^First line\n\n```age\n[\s\S]+\n```\n\nSecond line\n$/u);
		expect(h.opened()).toEqual(['a new secret']);
		const panelLine = h.container.querySelector('.secret-raw-panel')?.previousElementSibling;
		expect(panelLine?.textContent).toBe('```');
		expect(h.field()).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe(5);

		h.type('a new secret, longer');
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['a new secret, longer']);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('takes its fence out with Cancel, after it was typed in', async () => {
		const fake = fakeHost();
		const body = 'First line\n\nSecond line\n';
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, 3);
		h.type('changed my mind');
		expect(h.text()).toContain('```age');

		h.press('Cancel');

		expect(h.field()).toBeNull();
		expect(h.text()).toBe(body);
	});

	it('takes its fence out with Done, where it was emptied again', async () => {
		const fake = fakeHost();
		const body = 'First line\n\nSecond line\n';
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, 3);
		h.type('x');
		h.type('');

		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.text()).toBe(body);
	});

	it('takes its fence out with Cancel at the end of a note with no line break there, as it was', async () => {
		const fake = fakeHost();
		const h = mount('Only line', fake.host);
		await h.inserted(fake.insert, 9);
		h.type('then cancelled');
		expect(h.text()).toMatch(/^Only line\n\n```age\n[\s\S]+\n```$/u);

		h.press('Cancel');

		expect(h.text()).toBe('Only line');
	});

	it.each([
		['words right under its line', 'First line\nSecond line\n', 3],
		['a list item’s', '- one\n  more of one\n- two\n', 2],
		['a quote’s', '> a\n> b\n', 2],
		['two empty lines', 'a\n\n\nb\n', 3],
		['a heading’s underline', 'Title\n=====\nmore\n', 2],
	])('leaves the note as it was with Cancel, begun above %s', async (_, body, at) => {
		const fake = fakeHost();
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, at);
		h.type('then');
		h.type('then cancelled');
		expect(h.opened()).toEqual(['then cancelled']);

		h.press('Cancel');

		expect(h.text()).toBe(body);
	});

	it('writes a secret, and goes on keeping it, with the cursor in a fence left open', async () => {
		const fake = fakeHost();
		const body = 'Text\n\n```js\ncode\n';
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, body.indexOf('code'));
		const below = h.container.querySelector('.secret-raw-panel')?.nextElementSibling;
		expect(below?.textContent).toBe('```js');

		h.type('first');
		h.type('first, then more');
		await Promise.resolve();

		expect(h.field()).not.toBeNull();
		expect(h.opened()).toEqual(['first, then more']);
		expect(allSecrets(h.view.state)).toHaveLength(1);
		expect(h.text().endsWith('```js\ncode\n')).toBe(true);
	});

	it('stays where it was begun, as a pull changes the note above it', async () => {
		const fake = fakeHost();
		const body = 'First.\n\nSecond.\n\nThird.\n';
		const h = mount(body, fake.host);
		await h.inserted(fake.insert, body.indexOf('Third'));

		h.pulled(body.replace('First.', 'First, edited.'));
		await Promise.resolve();
		const panelLine = h.container.querySelector('.secret-raw-panel')?.previousElementSibling;
		expect(panelLine?.textContent).toBe('Third.');
		h.type('words');

		expect(h.text()).toMatch(
			/^First, edited\.\n\nSecond\.\n\nThird\.\n\n```age\n[\s\S]+\n```\n$/u
		);
	});

	it('goes at the end of a note whose last line is empty, which still ends with a line break', async () => {
		const fake = fakeHost();
		const h = mount('Only line\n', fake.host);
		await h.inserted(fake.insert, 10);

		h.type('at the end');

		expect(h.text()).toMatch(/^Only line\n\n```age\n[\s\S]+\n```\n$/u);
	});
});

describe('locking in raw mode', () => {
	it('closes every panel at once, what was typed in them in the note already', async () => {
		const fake = fakeHost();
		const h = mount(`${fence(sealed('one'))}\n\n${fence(sealed('two'))}\n`, fake.host);
		await h.revealed();
		h.type('one, changed');
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.container.querySelectorAll('.secret-words')).toHaveLength(2);
		});

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.button('Reveal')).toBeDefined();
		expect(h.container.querySelector('.secret-panel')).toBeNull();
		expect(h.opened()).toEqual(['one, changed', 'two']);
		expect(fake.seal).toHaveBeenCalledTimes(1);
	});

	it('closes a new secret’s panel, a character still being composed in the note where it was written', async () => {
		const fake = fakeHost();
		const h = mount('Before.\n\nAfter.\n', fake.host);
		await h.inserted(fake.insert, 3);
		h.type('writtenあ', { composing: true });

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.container.querySelector('.secret-raw-panel')).toBeNull();
		expect(h.opened()).toEqual(['writtenあ']);
		expect(h.text()).toMatch(/^Before\.\n\n```age\n[\s\S]+\n```\n\nAfter\.\n$/u);
	});
});

describe('the editor going in raw mode', () => {
	it('has reported every word typed before it went', async () => {
		const fake = fakeHost();
		const h = mount(`${fence(sealed('one'))}\n`, fake.host);
		await h.revealed();

		h.type('typed, then the note closed');
		h.unmount();

		expect(h.reported()).toEqual(['typed, then the note closed']);
	});

	it('keeps a word an input method is still composing as it goes', async () => {
		const fake = fakeHost();
		const h = mount(`${fence(sealed('pin'))}\n`, fake.host);
		await h.revealed();
		h.type('pin 1234');
		h.type('pin 1234 hunter2', { composing: true });
		expect(h.reported()).toEqual(['pin 1234']);

		h.unmount();

		expect(h.reported()).toEqual(['pin 1234 hunter2']);
	});
});

describe('a secret that goes from under its panel in raw mode', () => {
	it('closes the panel where a pull replaced it, what was typed reported before', async () => {
		const fake = fakeHost();
		const theirs = sealed('changed on another device');
		const h = mount(`Front.\n\n${fence(sealed('mine'))}\n\nBack.\n`, fake.host);
		await h.revealed();
		h.type('typed before the pull');

		h.pulled(`Front.\n\n${fence(theirs)}\n\nBack.\n`);

		await vi.waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(h.reported()).toEqual(['typed before the pull']);
		expect(h.opened()).toEqual(['changed on another device']);
	});

	it('keeps the panel, its words and the focus in it, where a pull changes the note elsewhere', async () => {
		const fake = fakeHost();
		const h = mount(`Front.\n\n${fence(sealed('mine'))}\n\nBack.\n`, fake.host);
		await h.revealed();
		h.type('mine, typed', { caret: 4 });
		await Promise.resolve();
		const field = h.field();
		const watched = watchRemoval(h.container, field);

		h.pulled(h.text().replace('Front.', 'Front, edited elsewhere.'));
		await Promise.resolve();
		watched.stop();

		expect(watched.removed).not.toHaveBeenCalled();
		expect(h.field()).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe(4);
		h.type('mine, typed on');
		expect(h.opened()).toEqual(['mine, typed on']);
	});

	it('opens no panel for a secret a pull took away while it was being opened', async () => {
		const fake = fakeHost();
		const armor = sealed('mine');
		const h = mount(`${fence(armor)}\n`, fake.host);
		const opening = Promise.withResolvers<Opened>();
		vi.mocked(fake.host.open).mockReturnValueOnce(opening.promise);
		h.press('Reveal');

		h.pulled('Gone.\n');
		opening.resolve({ state: 'opened', words: 'mine', seal: fake.seal });
		await vi.waitFor(() => {
			expect(h.button('Reveal')).toBeUndefined();
		});
		await Promise.resolve();

		h.pulled(`${fence(armor)}\n`);
		expect(h.field()).toBeNull();
		expect(h.button('Reveal')).toBeDefined();
	});

	it('is let go of, with its panel, where the user changed its armor', async () => {
		const fake = fakeHost();
		const h = mount(`${fence(sealed('mine'))}\n`, fake.host);
		await h.revealed();
		h.type('typed, then the armor edited');
		const kept = h.text();

		const at = h.text().indexOf('-----END');
		h.view.dispatch({
			changes: { from: at, insert: 'x' },
			annotations: isolateHistory.of('before'),
			userEvent: 'input.type',
		});
		await Promise.resolve();

		expect(h.field()).toBeNull();

		// Undone, it is back as it was kept, closed: the panel went with it.
		undo(h.view);
		await Promise.resolve();

		expect(h.text()).toBe(kept);
		expect(h.field()).toBeNull();
		expect(h.button('Reveal')).toBeDefined();
	});
});
