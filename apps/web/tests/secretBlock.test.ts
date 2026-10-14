import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectedKey } from '../src/editor/attachment.js';
import { adoptBody, createRichEditor, currentMarkdown } from '../src/editor/rich.js';
import { insertSecretCommand } from '../src/editor/secretBlock.js';
import { NO_SECRETS, type SecretHost } from '../src/editor/secretHost.js';
import {
	generateIdentity,
	openSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';

/**
 * A secret in the rich editor (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * one closed block, its words revealed in a panel outside the document, and
 * the document changed only where the words did, as the user's edit.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const identity = generateIdentity();
const recipient = parseRecipient(recipientOf(identity));

const sealed = async (words: string): Promise<string> => {
	if (recipient === undefined) throw new Error('not a recipient');
	return sealSecret(words, recipient);
};

const fence = (armor: string) => `\`\`\`age\n${armor}\n\`\`\``;

/** A host over one key, which opens what it made, and is told when to lock. */
const fakeHost = (sealable = true) => {
	const locks = new Set<() => void>();
	const receiving = { current: (): void => undefined };
	const host: SecretHost = {
		sealable: vi.fn(() => Promise.resolve(sealable)),
		open: vi.fn(async (armor: string) => {
			try {
				return { state: 'opened' as const, words: await openSecret(armor, [identity]) };
			} catch {
				return { state: 'other' as const };
			}
		}),
		seal: vi.fn(async (words: string) => ({
			state: 'sealed' as const,
			armor: await sealed(words),
		})),
		copy: vi.fn(() => Promise.resolve(true)),
		locked: (listener) => {
			locks.add(listener);
			return () => {
				locks.delete(listener);
			};
		},
		receive: (insert) => {
			receiving.current = insert;
			return () => {
				receiving.current = () => undefined;
			};
		},
	};
	return {
		host,
		lock: () => {
			locks.forEach((listener) => {
				listener();
			});
		},
		insert: () => {
			receiving.current();
		},
	};
};

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
	const type = (words: string) => {
		const into = field();
		if (into === null) throw new Error('no panel');
		into.value = words;
		into.dispatchEvent(new Event('input', { bubbles: true }));
	};
	/** The focus gone from the panel, to nowhere in it. */
	const leave = () => {
		root.querySelector('.secret-panel')?.dispatchEvent(
			new FocusEvent('focusout', { bubbles: true, relatedTarget: null })
		);
	};
	const markdown = () => editor.action(currentMarkdown);
	/** The words each secret in the note opens to, in order. */
	const opened = () =>
		Promise.all(
			[...markdown().matchAll(/```age\n([\s\S]*?)\n```/gu)].map((match) =>
				openSecret(match[1] ?? '', [identity])
			)
		);
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
		leave,
		markdown,
		opened,
	};
};

describe('a secret in the rich editor', () => {
	it('is one closed block, with nothing of its armor in the text, written back as it was read', async () => {
		const armor = await sealed('the door code');
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
		const armor = await sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);
		const dispatch = vi.spyOn(h.view, 'dispatch');

		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()?.value).toBe('the door code');
		});
		expect(h.view.state.doc.textContent).not.toContain('door');
		h.press('Cancel');

		expect(h.field()).toBeNull();
		expect(dispatch).not.toHaveBeenCalled();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('keeps the armor byte for byte where Done finds the words unchanged', async () => {
		const armor = await sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);

		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.press('Done');

		await vi.waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(fake.host.seal).not.toHaveBeenCalled();
		expect(h.onUserEdit).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('seals changed words once, as one edit of the user’s, in the block’s place', async () => {
		const armor = await sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`Front:\n\n${fence(armor)}\n\nBack.\n`, fake.host);

		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('the new door code');
		h.press('Done');

		await vi.waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(fake.host.seal).toHaveBeenCalledTimes(1);
		expect(h.onUserEdit).toHaveBeenCalledTimes(1);
		expect(await h.opened()).toEqual(['the new door code']);
		expect(h.markdown()).not.toContain(armor);
		expect(h.markdown()).toMatch(/^Front:\n\n```age\n[\s\S]+\n```\n\nBack\.\n$/u);
	});

	it('keeps what was typed as the focus leaves the panel, left open; Cancel then puts the block back', async () => {
		const armor = await sealed('the door code');
		const fake = fakeHost();
		const h = await mount(`${fence(armor)}\n`, fake.host);

		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('typed, then away');
		h.leave();

		await vi.waitFor(() => {
			expect(h.onUserEdit).toHaveBeenCalledTimes(1);
		});
		expect(await h.opened()).toEqual(['typed, then away']);
		expect(h.field()?.value).toBe('typed, then away');
		// Left again with nothing new: nothing sealed.
		h.leave();
		await Promise.resolve();
		expect(fake.host.seal).toHaveBeenCalledTimes(1);

		h.press('Cancel');
		expect(h.field()).toBeNull();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('keeps nothing as the focus moves between the panel’s own controls', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(await sealed('the door code'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('typed');

		h.root.querySelector('.secret-panel')?.dispatchEvent(
			new FocusEvent('focusout', {
				bubbles: true,
				relatedTarget: h.button('Cancel') ?? null,
			})
		);
		await Promise.resolve();

		expect(fake.host.seal).not.toHaveBeenCalled();
	});

	it('shows one panel for a secret pasted twice, under the first', async () => {
		const armor = await sealed('the door code');
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
		const armor = await sealed('the door code');
		const fake = fakeHost();
		const answers: ((words: string) => void)[] = [];
		vi.mocked(fake.host.open).mockImplementation(
			() =>
				new Promise((resolve) => {
					answers.push((words) => {
						resolve({ state: 'opened', words });
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

	it('says why a secret will not reveal', async () => {
		const fake = fakeHost();
		const other = generateIdentity();
		const theirs = parseRecipient(recipientOf(other));
		if (theirs === undefined) throw new Error('not a recipient');
		const h = await mount(`${fence(await sealSecret('theirs', theirs))}\n`, fake.host);

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
		const h = await mount(`${fence(await sealed('the door code'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});

		h.press('Copy');

		expect(fake.host.copy).toHaveBeenCalledWith('the door code');
		await vi.waitFor(() => {
			expect(h.root.querySelector('.secret-said')?.textContent).toBe('Copied.');
		});
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

		await vi.waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(h.root.querySelector('.secret-draft')).toBeNull();
		expect(h.onUserEdit).not.toHaveBeenCalled();
	});

	it('inserts one block of what was typed, from the palette as from the slash menu', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);

		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('a new secret');
		h.press('Done');

		await vi.waitFor(() => {
			expect(h.blocks()).toHaveLength(1);
		});
		expect(h.field()).toBeNull();
		expect(h.onUserEdit).toHaveBeenCalledTimes(1);
		expect(await h.opened()).toEqual(['a new secret']);
	});

	it('begins nothing where no secret can be sealed', async () => {
		const fake = fakeHost(false);
		const h = await mount('Before.\n', fake.host);

		h.editor.action(insertSecretCommand);

		await vi.waitFor(() => {
			expect(fake.host.sealable).toHaveBeenCalled();
		});
		expect(h.field()).toBeNull();
	});

	it('takes the panel out with Cancel, after its words were kept as the focus left it', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('kept a moment');
		h.leave();
		await vi.waitFor(() => {
			expect(h.blocks()).toHaveLength(1);
		});
		// Moved into its block, and still open there, with the focus it had.
		expect(h.blocks()[0]?.querySelector('.secret-words')).not.toBeNull();
		expect(document.activeElement).toBe(h.field());

		h.press('Cancel');

		expect(h.blocks()).toHaveLength(0);
		expect(h.markdown()).toBe('Before.\n');
	});
});

describe('locking', () => {
	it('closes every panel at once, and keeps what changed in them', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(await sealed('one'))}\n\nAfter.\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('one, changed');

		fake.lock();

		expect(h.field()).toBeNull();
		await vi.waitFor(async () => {
			expect(await h.opened()).toEqual(['one, changed']);
		});
		expect(h.root.textContent).not.toContain('one, changed');
	});

	it('keeps one secret where Done is still sealing as the tab locks', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(await sealed('one'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('one, changed');
		const gate = { open: (): void => undefined };
		vi.mocked(fake.host.seal).mockImplementationOnce(async (words: string) => {
			await new Promise<void>((resolve) => {
				gate.open = resolve;
			});
			return { state: 'sealed', armor: await sealed(words) };
		});

		h.press('Done');
		await vi.waitFor(() => {
			expect(fake.host.seal).toHaveBeenCalledTimes(1);
		});
		fake.lock();
		await vi.waitFor(async () => {
			expect(await h.opened()).toEqual(['one, changed']);
		});
		// Done's sealing ends after the lock kept the words: it puts nothing.
		gate.open();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.blocks()).toHaveLength(1);
		expect(h.field()).toBeNull();
	});

	it('seals nothing for a panel whose words did not change', async () => {
		const fake = fakeHost();
		const armor = await sealed('one');
		const h = await mount(`${fence(armor)}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});

		fake.lock();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(h.field()).toBeNull();
		expect(fake.host.seal).not.toHaveBeenCalled();
		expect(h.markdown()).toBe(`${fence(armor)}\n`);
	});

	it('keeps a new secret’s words where it was being written', async () => {
		const fake = fakeHost();
		const h = await mount('Before.\n', fake.host);
		fake.insert();
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('written, then locked');

		fake.lock();

		expect(h.field()).toBeNull();
		await vi.waitFor(async () => {
			expect(await h.opened()).toEqual(['written, then locked']);
		});
	});
});

describe('a block that goes from under its panel', () => {
	it('has new words put back beside what came in its place, where a pull replaced it', async () => {
		const fake = fakeHost();
		const theirs = await sealed('changed on another device');
		const h = await mount(`${fence(await sealed('ours'))}\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('ours, edited here');

		h.editor.action((ctx) => adoptBody(ctx, `${fence(theirs)}\n`));

		await vi.waitFor(async () => {
			expect(await h.opened()).toEqual(['changed on another device', 'ours, edited here']);
		});
		expect(h.field()).toBeNull();
	});

	it('is let go of, with its panel, where the user deleted it', async () => {
		const fake = fakeHost();
		const h = await mount(`${fence(await sealed('ours'))}\n\nAfter.\n`, fake.host);
		h.press('Reveal');
		await vi.waitFor(() => {
			expect(h.field()).not.toBeNull();
		});
		h.type('ours, edited here');

		const { state } = h.view;
		h.view.dispatch(
			state.tr.setSelection(NodeSelection.create(state.doc, 0)).deleteSelection()
		);
		await Promise.resolve();

		expect(h.field()).toBeNull();
		expect(fake.host.seal).not.toHaveBeenCalled();
		expect(h.markdown()).toBe('After.\n');
	});
});
