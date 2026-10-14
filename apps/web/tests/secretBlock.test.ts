import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { closeHistory, undo } from '@milkdown/kit/prose/history';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedKey } from '../src/editor/attachment.js';
import { adoptBody, createRichEditor, currentMarkdown } from '../src/editor/rich.js';
import { insertSecretCommand } from '../src/editor/secretBlock.js';
import { NO_SECRETS, type Sealer, type SecretHost } from '../src/editor/secretHost.js';
import { fakeHost, fence, openedIn, sealed, sealedForAnother } from './secretHostFake.js';

/**
 * A secret in the rich editor (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * one closed block, its words revealed in a panel outside the document, and
 * the document changed only where the words did, as they are typed, as the
 * user's edit.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const mount = async (body: string, host: SecretHost = NO_SECRETS) => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body, onUserEdit, secrets: host }).create();
	editors.push(editor);
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
