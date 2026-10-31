import { editorViewCtx } from '@milkdown/kit/core';
import { closeHistory, undo } from '@milkdown/kit/prose/history';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedKey } from '../src/editor/nodeBar.js';
import { adoptBody, currentMarkdown } from '../src/editor/rich/adopt.js';
import { insertSecretCommand } from '../src/editor/secretBlock.js';
import { NO_SECRETS, type Sealer, type SecretHost } from '../src/editor/secretHost.js';
import { labelToWrite } from '../src/editor/secretPanels.js';
import { fakeHost, fence, openedIn, sealed, sealedForAnother } from './secretHostFake.js';
import { destroyRichEditors, mountRich } from './support/editor.js';

/**
 * A secret in the rich editor (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * one closed block, its words revealed in a panel outside the document, and
 * the document changed only where the words did, as they are typed, as the
 * user's edit.
 */

afterEach(async () => {
	await destroyRichEditors();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const mount = async (body: string, host: SecretHost = NO_SECRETS) => {
	const onUserEdit = vi.fn();
	const { editor, root } = await mountRich({ body, onUserEdit, secrets: host });
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	const blocks = () => [...root.querySelectorAll<HTMLElement>('.secret-block')];
	const field = () => root.querySelector<HTMLTextAreaElement>('.secret-words');
	const button = (name: string) =>
		[...root.querySelectorAll<HTMLButtonElement>('button')].find(
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
	const markdown = () => editor.action(currentMarkdown);
	/** The words each secret in the note opens to, in order. */
	const opened = () => openedIn(markdown());
	/** The words each secret opens to in the last body the editor reported as the user's. */
	const reported = () => openedIn(String(onUserEdit.mock.lastCall?.[0] ?? ''));
	const revealed = async () => {
		press('Reveal');
		await vi.waitFor(() => {
			expect(field()).not.toBeNull();
		});
	};
	return {
		editor,
		view,
		root,
		onUserEdit,
		blocks,
		field,
		button,
		press,
		type,
		markdown,
		opened,
		reported,
		revealed,
	};
};

describe('a secret in the rich editor', () => {
	it('is one closed block, with nothing of its armor in the text, written back as it was read', async () => {
		const armor = sealed('the door code');
		const body = `Front:\n\n${fence(armor)}\n\nBack.\n`;
		const h = await mount(body);

		expect(h.blocks()).toHaveLength(1);
		expect(h.blocks()[0]?.textContent).toContain('Secret');
		expect(h.root.textContent).not.toContain('BEGIN AGE');
		expect(h.view.state.doc.textContent).not.toContain('BEGIN AGE');
		expect(h.markdown()).toBe(body);
	});

	it('leaves an age fence that holds no armor a code block', async () => {
		const body = '```age\nage -d -i key.txt secret.age\n```\n';
		const h = await mount(body);

		expect(h.blocks()).toHaveLength(0);
		expect(h.root.querySelector('pre')?.textContent).toContain('age -d -i key.txt');
		expect(h.markdown()).toBe(body);
	});

	it('reveals and hides with no transaction at all, and leaves the note as it was', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		const dispatch = vi.spyOn(h.view, 'dispatch');

		await h.revealed();
		expect(h.field()?.value).toBe('the door code');
		expect(h.view.state.doc.textContent).not.toContain('door');
		h.press('Cancel');

		expect(h.field()).toBeNull();
		expect(dispatch).not.toHaveBeenCalled();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('keeps the armor byte for byte where Done finds the words unchanged', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();

		h.type('the door code');
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(fake.seal).not.toHaveBeenCalled();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('keeps what is typed as it is typed, each change the user’s edit, in the block’s place', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`Front:\n\n${fence(armor)}\n\nBack.\n`, fake.host);
		await h.revealed();
		const field = h.field();
		field?.focus();
		// Never out of the page while it is typed in: on a phone, the keyboard
		// goes with the focus.
		const removed: Node[] = [];
		const watching = new MutationObserver((records) => {
			removed.push(...records.flatMap((record) => [...record.removedNodes]));
		});
		watching.observe(h.root, { childList: true, subtree: true });

		h.type('the new door code', { caret: 3 });

		expect(fake.seal).toHaveBeenCalledTimes(1);
		expect(h.onUserEdit).toHaveBeenCalledTimes(1);
		expect(h.opened()).toEqual(['the new door code']);
		expect(h.markdown()).not.toContain(armor);
		expect(h.markdown()).toMatch(/^Front:\n\n```age\n[\s\S]+\n```\n\nBack\.\n$/u);
		// The same field, where it was, with the focus and the caret it had.
		await Promise.resolve();
		expect(h.field()).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe(3);

		h.type('the newer door code');
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
		await Promise.resolve();
		watching.disconnect();
		expect(removed.filter((node) => field !== null && node.contains(field))).toEqual([]);
		expect(h.opened()).toEqual(['the newer door code']);
		h.press('Done');
		expect(h.field()).toBeNull();
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('puts the block back as it was revealed with Cancel, after it was typed in', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();
		h.type('typed, then cancelled');
		expect(h.opened()).toEqual(['typed, then cancelled']);

		h.press('Cancel');

		expect(h.field()).toBeNull();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
	});

	it('waits for an input method to finish a character before keeping it', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('the door code'))}\n`, fake.host);
		await h.revealed();

		h.type('the door code\u3042', { composing: true });
		expect(fake.seal).not.toHaveBeenCalled();
		h.field()?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));

		expect(fake.seal).toHaveBeenCalledTimes(1);
		expect(h.opened()).toEqual(['the door code\u3042']);
	});

	it('says where what was typed could not be sealed, and stays open until it is', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('the door code'))}\n`, fake.host);
		await h.revealed();
		fake.seal.mockImplementation(() => {
			throw new Error('no');
		});

		h.type('not sealed');
		h.press('Done');

		expect(h.field()?.value).toBe('not sealed');
		expect(h.root.querySelector('.secret-said')?.textContent).toMatch(
			/could not be encrypted/u
		);
		expect(h.onUserEdit).not.toHaveBeenCalled();

		fake.seal.mockImplementation(sealed);
		h.type('sealed after all');
		expect(h.root.querySelector('.secret-said')?.textContent).toBe('');
		h.press('Done');
		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['sealed after all']);
	});

	it('shows one panel for a secret pasted twice, under the first', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n\n${fence(armor)}\n`, fake.host);

		h.root.querySelectorAll<HTMLButtonElement>('.secret-reveal')[1]?.click();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		await Promise.resolve();

		expect(h.root.querySelectorAll('.secret-words')).toHaveLength(1);
		expect(h.blocks()[0]?.querySelector('.secret-words')).not.toBeNull();

		// The first deleted: the panel is the other's now.
		const { state } = h.view;
		h.view.dispatch(
			state.tr.setSelection(NodeSelection.create(state.doc, 0)).deleteSelection()
		);
		await vi.waitFor(() => {
			expect(h.blocks()).toHaveLength(1);
			expect(h.blocks()[0]?.querySelector('.secret-words')).not.toBeNull();
		});
	});

	it('opens one panel where Reveal is asked for twice before the first answer', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const answers: ((words: string) => void)[] = [];
		vi.mocked(fake.host.open).mockImplementation(
			() =>
				new Promise((resolve) => {
					answers.push((words) => {
						resolve({ state: 'opened', words, seal: fake.seal });
					});
				})
		);
		const h = await mount(`${fence(armor)}\n\nAfter.\n`, fake.host);

		h.press('Reveal');
		// And Enter on the block selected whole, before the first is answered.
		h.view.dispatch(h.view.state.tr.setSelection(NodeSelection.create(h.view.state.doc, 0)));
		selectedKey(h.view, new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(answers).toHaveLength(2);

		answers[0]?.('the door code');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('typed in the first');
		answers[1]?.('the door code');
		await Promise.resolve();

		expect(h.root.querySelectorAll('.secret-words')).toHaveLength(1);
		expect(h.field()?.value).toBe('typed in the first');
	});

	it('takes Tab on the block selected whole to its panel, where it is revealed', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('the door code'))}\n\nAfter.\n`, fake.host);
		await h.revealed();
		h.view.focus();

		h.view.dispatch(h.view.state.tr.setSelection(NodeSelection.create(h.view.state.doc, 0)));
		expect(selectedKey(h.view, new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);

		expect(document.activeElement).toBe(h.field());
	});

	it('says why a secret will not reveal', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealedForAnother('theirs'))}\n`, fake.host);

		h.press('Reveal');

		await vi.waitFor(() => {
			expect(h.root.querySelector('.secret-note')?.textContent).toBe(
				'This secret was made with a different key, which this device does not have.'
			);
		});
		expect(h.field()).toBeNull();
	});

	it('offers to add the key a secret was made with, and reveals it once that key is added', async () => {
		const fake = fakeHost();
		const armor = sealed('from the old notes');
		vi.mocked(fake.host.open).mockResolvedValueOnce({ state: 'other' });
		vi.mocked(fake.host.addKey).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const h = await mount(`${fence(armor)}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.button('Add its key')).toBeDefined();
		});

		h.press('Add its key');
		await vi.waitFor(() => {
			expect(h.button('Add its key')?.disabled).toBe(false);
		});
		expect(fake.host.addKey).toHaveBeenCalledWith(armor);
		expect(h.field()).toBeNull();

		h.press('Add its key');
		await vi.waitFor(() => {
			expect(h.field()?.value).toBe('from the old notes');
		});
		expect(h.button('Add its key')).toBeUndefined();
		expect(h.root.querySelector('.secret-note')?.textContent).toBe('');
	});

	it('can be asked again where adding the key failed', async () => {
		const fake = fakeHost();
		vi.mocked(fake.host.open).mockResolvedValueOnce({ state: 'other' });
		vi.mocked(fake.host.addKey).mockRejectedValueOnce(new Error('gone'));
		const h = await mount(`${fence(sealed('x'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.button('Add its key')).toBeDefined();
		});

		h.press('Add its key');

		await vi.waitFor(() => {
			expect(h.button('Add its key')?.disabled).toBe(false);
		});
		expect(h.field()).toBeNull();
	});

	it('offers no key to add for a secret this app cannot read', async () => {
		const fake = fakeHost();
		vi.mocked(fake.host.open).mockResolvedValueOnce({ state: 'unreadable' });
		const h = await mount(`${fence(sealed('x'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.root.querySelector('.secret-note')?.textContent).toBe(
				'This secret cannot be read by this version of the app.'
			);
		});
		expect(h.button('Add its key')).toBeUndefined();
	});

	it('puts revealed words on the clipboard, and says so', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('the door code'))}\n`, fake.host);
		await h.revealed();

		h.press('Copy');

		expect(fake.host.copy).toHaveBeenCalledWith('the door code');
		await vi.waitFor(() => {
			expect(h.root.querySelector('.secret-said')?.textContent).toBe('Copied.');
		});
	});

	it('lets no words be dragged out of the panel', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('the door code'))}\n`, fake.host);
		await h.revealed();

		const drag = new Event('dragstart', { bubbles: true, cancelable: true });
		h.field()?.dispatchEvent(drag);

		expect(drag.defaultPrevented).toBe(true);
	});
});

/**
 * A secret's label: what its fence says after `age`, in plain text, shown on
 * the closed block in place of "Secret" and changed in its panel as it is
 * typed, with nothing sealed.
 */
describe('a secret’s label', () => {
	const labelField = (root: HTMLElement) =>
		root.querySelector<HTMLInputElement>('.secret-label-field');
	const shown = (h: { blocks: () => HTMLElement[] }) =>
		h.blocks()[0]?.querySelector('.secret-label')?.textContent;
	/** `words` in the label, as typing them leaves it. */
	const name = (root: HTMLElement, words: string, { composing = false } = {}) => {
		const into = labelField(root);
		if (into === null) throw new Error('no label');
		into.value = words;
		into.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
	};

	it('is what the closed block says, written back as the fence has it, spaces and all', async () => {
		const body = `${fence(sealed('the door code'), 'Front door  ')}\n\nAfter.\n`;
		const h = await mount(body);

		expect(shown(h)).toBe('Front door');
		expect(h.markdown()).toBe(body);
	});

	it('is written as one line, with no backtick, and no longer than its field', () => {
		expect(labelToWrite('  Wi-Fi\r\n\t`home`  ')).toBe('Wi-Fi home');
		expect(labelToWrite('``')).toBe('');
		expect(labelToWrite(`${'a'.repeat(79)} more`)).toBe('a'.repeat(79));
	});

	it('is "Secret" where the fence says nothing after `age`', async () => {
		const h = await mount(`${fence(sealed('the door code'))}\n`);

		expect(shown(h)).toBe('Secret');
	});

	it('is changed as it is typed, the user’s edit, with nothing sealed', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();
		expect(labelField(h.root)?.value).toBe('');

		name(h.root, 'Front door');

		expect(h.markdown()).toBe(`${fence(armor, 'Front door')}\n`);
		expect(h.onUserEdit).toHaveBeenCalledTimes(1);
		expect(fake.seal).not.toHaveBeenCalled();
		expect(shown(h)).toBe('Front door');
		expect(h.field()).not.toBeNull();
	});

	it('stays as it is as the words are sealed again, and both go back with Cancel', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor, 'Front door')}\n`, fake.host);
		await h.revealed();
		expect(labelField(h.root)?.value).toBe('Front door');

		h.type('the new code');
		expect(h.markdown()).toContain('```age Front door\n');
		name(h.root, 'Back door');
		expect(h.markdown()).toContain('```age Back door\n');
		expect(h.opened()).toEqual(['the new code']);

		h.press('Cancel');

		expect(h.markdown()).toBe(`${fence(armor, 'Front door')}\n`);
	});

	it('goes back with Cancel where it is all that changed', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor, 'Front door')}\n`, fake.host);
		await h.revealed();
		name(h.root, 'Back door');

		h.press('Cancel');

		expect(h.markdown()).toBe(`${fence(armor, 'Front door')}\n`);
		expect(shown(h)).toBe('Front door');
	});

	it('is taken off the fence where it is emptied, and the block is "Secret" again', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor, 'Front door')}\n`, fake.host);
		await h.revealed();

		name(h.root, '   ');

		expect(h.markdown()).toBe(`${fence(armor)}\n`);
		expect(shown(h)).toBe('Secret');
	});

	it('is written with no backtick to end the fence’s first line, its spacing made one', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();

		name(h.root, '  Wi-Fi\t`home`  ');

		expect(h.markdown()).toBe(`${fence(armor, 'Wi-Fi home')}\n`);
	});

	it('goes in with a new secret’s first words, where it was typed before them', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});

		name(h.root, 'Locker');
		expect(h.blocks()).toHaveLength(0);
		expect(h.onUserEdit).not.toHaveBeenCalled();
		h.type('1234');
		await Promise.resolve();

		expect(h.markdown()).toContain('```age Locker\n');
		expect(h.opened()).toEqual(['1234']);
		expect(labelField(h.root)?.value).toBe('Locker');
	});

	it('keeps a character an input method was still composing as the tab locks', async () => {
		const fake = fakeHost();
		const armor = sealed('one');
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();
		name(h.root, 'Door\u3042', { composing: true });
		expect(h.markdown()).toBe(`${fence(armor)}\n`);

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.markdown()).toBe(`${fence(armor, 'Door\u3042')}\n`);
		expect(fake.seal).not.toHaveBeenCalled();
	});

	it('is shown in the panel as the note has it once undone', async () => {
		const armor = sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor, 'Front door')}\n`, fake.host);
		await h.revealed();
		name(h.root, 'Back door');

		undo(h.view.state, (tr) => {
			h.view.dispatch(tr);
		});
		await Promise.resolve();

		expect(h.markdown()).toBe(`${fence(armor, 'Front door')}\n`);
		expect(labelField(h.root)?.value).toBe('Front door');
	});

	it('is a secret’s still, pasted from the editor’s own copy', async () => {
		const armor = sealed('the door code');
		const h = await mount(`Before.\n\n${fence(armor, 'Front door')}\n\nAfter.\n`);
		const { state } = h.view;
		const at = state.doc.child(0).nodeSize;
		const { dom } = h.view.serializeForClipboard(NodeSelection.create(state.doc, at).content());
		const end = state.doc.content.size - 1;
		h.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)));
		vi.stubGlobal(
			'ClipboardEvent',
			class extends Event {
				readonly clipboardData = null;
			}
		);

		h.view.pasteHTML(dom.innerHTML);

		expect(h.blocks()).toHaveLength(2);
		expect(h.markdown().split(fence(armor, 'Front door'))).toHaveLength(3);
	});
});

describe('a secret copied and pasted', () => {
	it('is a secret still, pasted from the editor’s own copy', async () => {
		const armor = sealed('the door code');
		const h = await mount(`Before.\n\n${fence(armor)}\n\nAfter.\n`);
		const { state } = h.view;
		const at = state.doc.child(0).nodeSize;
		const { dom } = h.view.serializeForClipboard(NodeSelection.create(state.doc, at).content());
		const end = state.doc.content.size - 1;
		h.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)));

		// What ProseMirror makes the paste with, which jsdom does not have.
		vi.stubGlobal(
			'ClipboardEvent',
			class extends Event {
				readonly clipboardData = null;
			}
		);
		h.view.pasteHTML(dom.innerHTML);

		expect(h.blocks()).toHaveLength(2);
		expect(h.markdown().split(fence(armor))).toHaveLength(3);
	});

	it('is a secret still, pasted as markdown text', async () => {
		const armor = sealed('the door code');
		const h = await mount('Before.\n\nAfter.\n');
		const end = h.view.state.doc.content.size - 1;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, end)));
		const clipboardData = {
			files: [],
			items: [],
			types: ['text/plain'],
			getData: (kind: string) => (kind === 'text/plain' ? `${fence(armor)}\n` : ''),
		};
		const event = {
			clipboardData,
			preventDefault: () => undefined,
		} as unknown as ClipboardEvent;

		h.view.someProp('handlePaste', (paste) =>
			paste(h.view, event, h.view.state.doc.slice(0, 0))
		);

		expect(h.blocks()).toHaveLength(1);
		expect(h.markdown()).toContain(fence(armor));
	});
});

describe('inserting a secret', () => {
	it('opens an empty panel where the cursor is, and inserts nothing where nothing is typed', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n\n\n\nAfter.\n', fake.host);

		h.editor.action(insertSecretCommand);
		await vi.waitFor(() => {
			expect(h.root.querySelector('.secret-draft .secret-words')).not.toBeNull();
		});
		h.press('Done');

		expect(h.field()).toBeNull();
		expect(h.root.querySelector('.secret-draft')).toBeNull();
		expect(h.onUserEdit).not.toHaveBeenCalled();
	});

	it('inserts one block of what is typed, the panel moving into it with the focus and caret it had', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);

		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		const field = h.field();
		h.type('a new secret', { caret: 5 });
		await Promise.resolve();
		expect(field?.selectionStart).toBe(5);
		h.type('a new secret, longer', { caret: 5 });
		await Promise.resolve();

		expect(h.blocks()).toHaveLength(1);
		expect(h.blocks()[0]?.querySelector('.secret-words')).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe(5);
		expect(h.onUserEdit).toHaveBeenCalledTimes(2);
		expect(h.opened()).toEqual(['a new secret, longer']);
		h.press('Done');
		expect(h.field()).toBeNull();
		expect(h.blocks()).toHaveLength(1);
	});

	it('begins one, where it is chosen again before the device answers', async () => {
		const fake = fakeHost();
		const first = Promise.withResolvers<Sealer | undefined>();
		const second = Promise.withResolvers<Sealer | undefined>();
		vi.mocked(fake.host.begin)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		fake.insert();

		first.resolve(fake.seal);
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		const field = h.field();
		second.resolve(fake.seal);
		await second.promise;
		await Promise.resolve();

		expect(h.root.querySelectorAll('.secret-words')).toHaveLength(1);
		expect(h.field()).toBe(field);
		expect(document.activeElement).toBe(field);
		h.type('typed in the one there is');
		expect(h.opened()).toEqual(['typed in the one there is']);
	});

	it('begins nothing where no secret can be sealed', async () => {
		const fake = fakeHost(false);
		const h = await mount('Before.\n', fake.host);

		h.editor.action(insertSecretCommand);

		await vi.waitFor(() => {
			expect(fake.host.begin).toHaveBeenCalled();
		});
		expect(h.field()).toBeNull();
		expect(h.root.querySelector('.secret-draft')).toBeNull();
	});

	it('takes its block out with Cancel, after it was typed in', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('kept a moment');
		expect(h.blocks()).toHaveLength(1);

		h.press('Cancel');

		expect(h.blocks()).toHaveLength(0);
		expect(h.markdown()).toBe('Before.\n');
	});

	it('takes its block out with Done, where it was emptied again', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('x');
		h.type('');

		h.press('Done');

		expect(h.blocks()).toHaveLength(0);
		expect(h.markdown()).toBe('Before.\n');
	});
});

describe('locking', () => {
	it('closes every panel at once, what was typed in them in the note already', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('one'))}\n\nAfter.\n`, fake.host);
		await h.revealed();
		h.type('one, changed');

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['one, changed']);
		expect(fake.seal).toHaveBeenCalledTimes(1);
		expect(h.root.textContent).not.toContain('one, changed');
	});

	it('keeps a character an input method was still composing', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('one'))}\n`, fake.host);
		await h.revealed();
		h.type('one\u3042', { composing: true });

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['one\u3042']);
	});

	it('seals nothing for a panel whose words did not change', async () => {
		const fake = fakeHost();
		const armor = sealed('one');
		const h = await mount(`${fence(armor)}\n`, fake.host);
		await h.revealed();

		fake.lock();

		expect(h.field()).toBeNull();
		expect(fake.seal).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('closes a new secret’s panel, its words in the note where it was being written', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n\nAfter.\n', fake.host);
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3)));
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('written, then locked');

		fake.lock();

		expect(h.field()).toBeNull();
		expect(h.opened()).toEqual(['written, then locked']);
		expect(h.markdown()).toMatch(/^Before\.\n\n```age\n[\s\S]+\n```\n\nAfter\.\n$/u);
	});
});

describe('the editor going', () => {
	it('has reported every word typed before it went, there being nothing left to keep', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('one'))}\n`, fake.host);
		await h.revealed();

		h.type('typed, then the note closed');
		await h.editor.destroy();

		expect(h.reported()).toEqual(['typed, then the note closed']);
	});
});

/**
 * A secret selected whole has a bar, as a picture has, with Delete secret: a
 * phone's keyboard may delete nothing for a block selected.
 */
describe('a secret selected whole', () => {
	const selected = async (host?: SecretHost) => {
		const mounted = await mount(`${fence(sealed('the door code'))}\n\nAfter.\n`, host);
		const { view } = mounted;
		view.focus();
		view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
		const remover = () =>
			mounted.root.querySelector<HTMLButtonElement>('[aria-label="Delete secret"]');
		return { ...mounted, remover };
	};

	it('shows Delete secret while it is selected, and not after', async () => {
		const { view, blocks, remover } = await selected();

		expect(blocks()[0]?.hasAttribute('data-selected')).toBe(true);
		expect(remover()?.closest('[hidden]')).toBeNull();

		view.dispatch(
			view.state.tr.setSelection(
				TextSelection.create(view.state.doc, view.state.doc.content.size - 1)
			)
		);

		expect(blocks()[0]?.hasAttribute('data-selected')).toBe(false);
		expect(remover()?.closest('[hidden]')).not.toBeNull();
	});

	it('is taken out of the note by Delete secret, as the user’s edit, and comes back with undo', async () => {
		const { view, blocks, remover, onUserEdit, opened } = await selected();

		remover()?.click();

		expect(blocks()).toHaveLength(0);
		expect(onUserEdit).toHaveBeenLastCalledWith('After.\n');

		undo(view.state, (tr) => {
			view.dispatch(tr);
		});

		expect(opened()).toEqual(['the door code']);
	});

	it('takes its panel with it, where it was revealed', async () => {
		const fake = fakeHost();
		const { view, revealed, field, remover, markdown } = await selected(fake.host);
		await revealed();
		view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));

		remover()?.click();
		await Promise.resolve();

		expect(field()).toBeNull();
		expect(markdown()).toBe('After.\n');
	});

	it('keeps a key pressed in its bar from the editor', async () => {
		const { view, remover } = await selected();
		const before = view.state.doc;

		remover()?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
		);

		expect(view.state.doc.eq(before)).toBe(true);
	});

	it('goes back to the block, still selected, with Escape in its bar', async () => {
		const { view, remover } = await selected();
		remover()?.focus();

		remover()?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);

		expect(view.hasFocus()).toBe(true);
		expect(view.state.selection).toBeInstanceOf(NodeSelection);
	});
});

describe('a block that goes from under its panel', () => {
	it('closes the panel where a pull replaced it, what was typed reported before, a heading and all', async () => {
		const fake = fakeHost();
		const theirs = sealed('changed on another device');
		const h = await mount(`# Title\n\n${fence(sealed('ours'))}\n`, fake.host);
		await h.revealed();
		h.type('ours, edited here');

		h.editor.action((ctx) => adoptBody(ctx, `# Title\n\n${fence(theirs)}\n`));

		await vi.waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(h.reported()).toEqual(['ours, edited here']);
		expect(h.opened()).toEqual(['changed on another device']);
	});

	it('is let go of, with its panel, where the user deleted it', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(sealed('ours'))}\n\nAfter.\n`, fake.host);
		await h.revealed();
		h.type('ours, edited here');

		const { state } = h.view;
		h.view.dispatch(
			closeHistory(state.tr)
				.setSelection(NodeSelection.create(state.doc, 0))
				.deleteSelection()
		);
		await Promise.resolve();

		expect(h.field()).toBeNull();
		expect(h.markdown()).toBe('After.\n');

		// Undone, it is back as it was kept, closed: the panel went with it.
		undo(h.view.state, (tr) => {
			h.view.dispatch(tr);
		});
		await Promise.resolve();

		expect(h.opened()).toEqual(['ours, edited here']);
		expect(h.field()).toBeNull();
		expect(h.button('Reveal')).toBeDefined();
	});
});
