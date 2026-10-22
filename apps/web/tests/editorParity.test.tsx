import { EditorSelection } from '@codemirror/state';
import { EditorView as RawView } from '@codemirror/view';
import { editorViewCtx } from '@milkdown/kit/core';
import { Slice } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as RichView } from '@milkdown/kit/prose/view';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Carried } from '../src/editor/addFiles.js';
import {
	type Added,
	type AttachmentHost,
	type AttachmentProblem,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { EMPTY_QUERY, type FindQuery, type FindTarget } from '../src/editor/find.js';
import { rawFindTarget } from '../src/editor/findRaw.js';
import { richFindTarget } from '../src/editor/findRich.js';
import { RawEditor } from '../src/editor/RawEditor.js';
import { currentMarkdown } from '../src/editor/rich.js';
import { RichEditor } from '../src/editor/RichEditor.js';
import type { SecretHost } from '../src/editor/secretHost.js';
import { settleEditors } from '../src/store/heldEdits.js';
import { linksOpened as opened } from './linksOpened.js';
import { fakeHost, fence, openedIn, sealed } from './secretHostFake.js';
import { destroyRichEditors, mountRich } from './support/editor.js';

/**
 * The two editors, held to one contract (#456), the way every provider is held
 * to `packages/core/tests/providers/contract.test.ts`. A note's markdown is
 * the only truth and either editor is a view of it (CLAUDE.md), so a feature
 * both editors offer is to behave the same in both: what is found, what a
 * replace leaves, where a link goes. Each editor has its own suite for what
 * is its alone; this one is for the drift between them, which is how the
 * link-range (#436) and secret-keeping (#439) bugs arrived — fixed in one
 * editor and not the other.
 *
 * Each case uses text that reads the same in the markdown as on the rich
 * surface: the raw editor searches the markdown, `**` and all, and the rich
 * one the words drawn, by design.
 */

interface Harness {
	readonly find: FindTarget;
	readonly markdown: () => string;
	/** The text the selection covers. */
	readonly selected: () => string;
	/** The cursor, `offset` characters into the first `text`. */
	readonly cursorIn: (text: string, offset?: number) => void;
	/** The address the link chip shows, or `null` while it is not shown. */
	readonly chipAddress: () => string | null;
	readonly pressChip: () => void;
	/** Alt+Enter, and whether the editor took it. */
	readonly altEnter: () => boolean;
	readonly edits: () => number;
}

const altEnterOn = (target: HTMLElement): boolean => {
	const event = new KeyboardEvent('keydown', {
		key: 'Enter',
		altKey: true,
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(event);
	return event.defaultPrevented;
};

const chipIn = (root: ParentNode) => {
	const chip = root.querySelector<HTMLElement>('.link-chip');
	return {
		address: () =>
			chip === null || chip.hidden
				? null
				: (chip.querySelector('.link-chip-address')?.textContent ?? null),
		press: () => {
			chip?.querySelector('button')?.click();
		},
	};
};

/** Where `text` starts in the rich document, plus `offset`. */
const richAt = (view: RichView, text: string, offset: number): number => {
	const found = { current: -1 };
	view.state.doc.descendants((node, pos) => {
		if (found.current !== -1 || !node.isText) return;
		const index = node.text?.indexOf(text) ?? -1;
		if (index !== -1) found.current = pos + index + offset;
	});
	if (found.current === -1) throw new Error(`no "${text}"`);
	return found.current;
};

const rich = async (body: string): Promise<Harness> => {
	const onUserEdit = vi.fn();
	const { editor, root } = await mountRich({ body, onUserEdit });
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	view.focus();
	return {
		find: richFindTarget(view),
		markdown: () => editor.action(currentMarkdown),
		selected: () => {
			const { from, to } = view.state.selection;
			return view.state.doc.textBetween(from, to);
		},
		cursorIn: (text, offset = 1) => {
			const at = richAt(view, text, offset);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
		},
		chipAddress: () => chipIn(root).address(),
		pressChip: () => {
			chipIn(root).press();
		},
		altEnter: () => altEnterOn(view.dom),
		edits: () => onUserEdit.mock.calls.length,
	};
};

// The raw editor is a component, so it is drawn as the app draws it.
// eslint-disable-next-line @typescript-eslint/require-await
const raw = async (body: string): Promise<Harness> => {
	const onUserEdit = vi.fn();
	const { container } = render(<RawEditor noteId="a" body={body} onUserEdit={onUserEdit} />);
	const view = RawView.findFromDOM(container);
	if (view === null) throw new Error('CodeMirror did not mount');
	return {
		find: rawFindTarget(view),
		markdown: () => view.state.doc.toString(),
		selected: () => {
			const { from, to } = view.state.selection.main;
			return view.state.sliceDoc(from, to);
		},
		cursorIn: (text, offset = 1) => {
			const index = view.state.doc.toString().indexOf(text);
			if (index === -1) throw new Error(`no "${text}"`);
			view.dispatch({ selection: EditorSelection.cursor(index + offset) });
		},
		chipAddress: () => chipIn(container).address(),
		pressChip: () => {
			chipIn(container).press();
		},
		altEnter: () => altEnterOn(view.contentDOM),
		edits: () => onUserEdit.mock.calls.length,
	};
};

afterEach(async () => {
	await destroyRichEditors();
	document.body.replaceChildren();
});

const query = (search: string, extra: Partial<FindQuery> = {}): FindQuery => ({
	...EMPTY_QUERY,
	search,
	...extra,
});

describe.each([
	['rich', rich],
	['raw', raw],
])('the %s editor', (_name, mount) => {
	describe('find', () => {
		const BODY = 'The alpha and the Alpha, then alphabet.\n';

		it.each([
			['a word, in any case', query('alpha'), 3],
			['a word, in its case', query('Alpha', { caseSensitive: true }), 1],
			['a whole word', query('alpha', { wholeWord: true }), 2],
			['a pattern', query('al.ha', { regexp: true }), 3],
			['nothing for an empty query', query(''), 0],
			['nothing for a pattern that does not compile', query('(', { regexp: true }), 0],
		])('counts %s', async (_case, q, total) => {
			const { find } = await mount(BODY);
			expect(find.count(q).total).toBe(total);
		});

		it('goes from match to match, and back, wrapping at the ends', async () => {
			const { find, selected } = await mount(BODY);
			const q = query('alpha', { wholeWord: true });

			find.next(q);
			expect(selected()).toBe('alpha');
			expect(find.count(q).current).toBe(1);
			find.next(q);
			expect(selected()).toBe('Alpha');
			expect(find.count(q).current).toBe(2);
			find.next(q);
			expect(find.count(q).current).toBe(1);
			find.next(q, true);
			expect(find.count(q).current).toBe(2);
		});

		it('replaces the match it is on, and only that one', async () => {
			const { find, markdown } = await mount(BODY);
			const q = query('alpha', { wholeWord: true, replace: 'beta' });

			find.next(q);
			find.replace(q);
			expect(markdown()).toBe('The beta and the Alpha, then alphabet.\n');
		});

		it('replaces every match at once', async () => {
			const { find, markdown } = await mount(BODY);

			find.replaceAll(query('alpha', { replace: 'beta' }));
			expect(markdown()).toBe('The beta and the beta, then betabet.\n');
		});

		// `literal` in `asSearchQuery`: what the user types in the replace field is
		// what goes in, a `$1` or a `\n` included, in both editors alike.
		it('takes the replacement as written, even for a pattern', async () => {
			const { find, markdown } = await mount(BODY);

			find.replaceAll(query('(a)lpha', { regexp: true, replace: '$1-' }));
			expect(markdown()).toBe('The $1- and the $1-, then $1-bet.\n');
		});

		it('counts an edit as the user’s', async () => {
			const { find, edits } = await mount(BODY);

			find.replaceAll(query('alpha', { replace: 'beta' }));
			expect(edits()).toBeGreaterThan(0);
		});
	});

	describe('links', () => {
		it('shows where the link the cursor is in goes, and only there', async () => {
			const { cursorIn, chipAddress } = await mount(
				'Plan: [the map](https://www.example.com/bay)\n'
			);

			cursorIn('map');
			expect(chipAddress()).toBe('example.com/bay');
			cursorIn('Plan', 2);
			expect(chipAddress()).toBeNull();
		});

		it.each([
			['a note', '[a note](other.md)\n'],
			['a script', '[a script](javascript:alert(1))\n'],
			['a heading', '[a heading](#top)\n'],
		])('shows no chip for a link to %s, which this app does not open', async (words, body) => {
			const { cursorIn, chipAddress } = await mount(body);

			cursorIn(words, 2);
			expect(chipAddress()).toBeNull();
		});

		it('opens the link from its chip, and that is no edit', async () => {
			const seen = opened();
			const { cursorIn, pressChip, edits } = await mount(
				'[the map](https://example.com/bay)\n'
			);

			cursorIn('map');
			pressChip();
			expect(seen).toEqual(['https://example.com/bay']);
			expect(edits()).toBe(0);
		});

		it('opens the link on Alt+Enter rather than breaking the line', async () => {
			const seen = opened();
			const { cursorIn, altEnter, markdown, edits } = await mount(
				'[the map](https://example.com/bay)\n'
			);

			cursorIn('map');
			expect(altEnter()).toBe(true);
			expect(seen).toEqual(['https://example.com/bay']);
			expect(markdown()).toBe('[the map](https://example.com/bay)\n');
			expect(edits()).toBe(0);
		});

		it('leaves Alt+Enter alone outside a link', async () => {
			const seen = opened();
			const { cursorIn, altEnter } = await mount('Plain words\n');

			cursorIn('words');
			altEnter();
			expect(seen).toEqual([]);
		});
	});
});

/**
 * A secret's panel, through each editor as the app draws it: a component, so
 * that what happens as an editor goes is part of what is compared (#439 was a
 * difference only the component showed).
 */
const drawn = {
	rich: (body: string, onUserEdit: () => void, secrets: SecretHost) =>
		render(
			<RichEditor
				noteId="a"
				body={body}
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
				secrets={secrets}
			/>
		),
	raw: (body: string, onUserEdit: () => void, secrets: SecretHost) =>
		render(
			<RawEditor
				noteId="a"
				body={body}
				origin={body}
				onUserEdit={onUserEdit}
				secrets={secrets}
			/>
		),
};

describe.each(['rich', 'raw'] as const)('a secret in the %s editor', (name) => {
	const mount = (words: string) => {
		const fake = fakeHost();
		const onUserEdit = vi.fn();
		const view = drawn[name](`Before.\n\n${fence(sealed(words))}\n`, onUserEdit, fake.host);
		const field = () => document.querySelector<HTMLTextAreaElement>('.secret-words');
		const press = async (label: string) => {
			const button = await waitFor(() => {
				const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
					(each) => each.textContent === label && !each.hidden
				);
				if (found === undefined) throw new Error(`no ${label}`);
				return found;
			});
			button.click();
		};
		const reveal = async () => {
			await press('Reveal');
			await waitFor(() => {
				expect(field()).not.toBeNull();
			});
		};
		/** `typed` in the open panel; `composing`, as an input method is mid-character. */
		const type = (typed: string, { composing = false }: { composing?: boolean } = {}) => {
			const into = field();
			if (into === null) throw new Error('no panel');
			into.value = typed;
			into.setSelectionRange(typed.length, typed.length);
			into.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
		};
		/** What each secret opens to in the last body reported as the user's. */
		const reported = () => openedIn(String(onUserEdit.mock.lastCall?.[0] ?? ''));
		return { ...fake, view, onUserEdit, field, press, reveal, type, reported };
	};

	it('reveals its words, and Cancel changes nothing', async () => {
		const h = mount('the door code');

		await h.reveal();
		expect(h.field()?.value).toBe('the door code');
		await h.press('Cancel');
		expect(h.field()).toBeNull();
		expect(h.onUserEdit).not.toHaveBeenCalled();
	});

	it('reports the words as they are typed, as the user’s edit', async () => {
		const h = mount('the door code');

		await h.reveal();
		h.type('the gate code');
		expect(h.reported()).toEqual(['the gate code']);
	});

	it('puts the words back with Cancel, after they were typed', async () => {
		const h = mount('the door code');

		await h.reveal();
		h.type('the gate code');
		await h.press('Cancel');
		expect(h.reported()).toEqual(['the door code']);
	});

	it('keeps what was typed as the secrets lock, and closes the panel', async () => {
		const h = mount('the door code');

		await h.reveal();
		h.type('the gate code');
		h.lock();
		await waitFor(() => {
			expect(h.field()).toBeNull();
		});
		expect(h.reported()).toEqual(['the gate code']);
	});

	it('keeps a word an input method is still composing as the editor goes', async () => {
		const h = mount('pin');

		await h.reveal();
		h.type('pin 1234');
		h.type('pin 1234 hunter2', { composing: true });
		h.view.unmount();
		expect(h.reported()).toEqual(['pin 1234 hunter2']);
	});
});

/** A host that answers each add from `answers`, in order, once the test opens it. */
const attachHost = (answers: readonly Added[]) => {
	const asked: { name: string; pasted: boolean }[] = [];
	const told: AttachmentProblem[] = [];
	const gate = { open: (): void => undefined };
	const opened = new Promise<void>((resolve) => {
		gate.open = resolve;
	});
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		add: async (file, { pasted }) => {
			asked.push({ name: file.name, pasted });
			await opened;
			return answers[asked.length - 1] ?? { state: 'failed' };
		},
		report: (problem) => {
			told.push(problem);
		},
	};
	return { host, asked, told, open: gate.open };
};

const fileAdded = (name: string): Added => ({
	state: 'added',
	fileId: `id-${name}`,
	href: name,
	label: name,
	kind: 'file',
	markdown: `[${name}](${name})`,
});

const carrying = (names: readonly string[], text = ''): Carried => ({
	files: names.map((name) => new File(['bytes'], name)),
	getData: (format) => (format === 'text/plain' ? text : ''),
});

const dropEvent = (data: Carried) => {
	const event = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: data });
	return event;
};

interface Attaching {
	readonly markdown: () => string;
	readonly edits: () => number;
	/** `text` selected, the first place it is. */
	readonly select: (text: string) => void;
	readonly paste: (data: Carried) => void;
	/** Dropped with the pointer just after the first `after`. */
	readonly drop: (data: Carried, after: string) => void;
	readonly close: () => Promise<void>;
}

const attachRich = async (body: string, host: AttachmentHost): Promise<Attaching> => {
	const onUserEdit = vi.fn();
	const { editor } = await mountRich({ body, onUserEdit, attachments: host });
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	return {
		markdown: () => editor.action(currentMarkdown),
		edits: () => onUserEdit.mock.calls.length,
		select: (text) => {
			const from = richAt(view, text, 0);
			view.dispatch(
				view.state.tr.setSelection(
					TextSelection.create(view.state.doc, from, from + text.length)
				)
			);
		},
		// As the editor is asked to: its own `handlePaste`.
		paste: (data) => {
			view.someProp('handlePaste', (handle) =>
				handle(view, { clipboardData: data } as unknown as ClipboardEvent, Slice.empty)
			);
		},
		drop: (data, after) => {
			vi.spyOn(view, 'posAtCoords').mockReturnValue({
				pos: richAt(view, after, after.length),
				inside: -1,
			});
			view.dom.dispatchEvent(dropEvent(data));
		},
		close: async () => {
			await editor.destroy();
		},
	};
};

// eslint-disable-next-line @typescript-eslint/require-await
const attachRaw = async (body: string, host: AttachmentHost): Promise<Attaching> => {
	const onUserEdit = vi.fn();
	const { container, unmount } = render(
		<RawEditor noteId="a" body={body} onUserEdit={onUserEdit} attachments={host} />
	);
	const view = RawView.findFromDOM(container);
	if (view === null) throw new Error('CodeMirror did not mount');
	const indexOf = (text: string) => {
		const index = view.state.doc.toString().indexOf(text);
		if (index === -1) throw new Error(`no "${text}"`);
		return index;
	};
	return {
		markdown: () => view.state.doc.toString(),
		edits: () => onUserEdit.mock.calls.length,
		select: (text) => {
			const from = indexOf(text);
			view.dispatch({ selection: { anchor: from, head: from + text.length } });
		},
		paste: (data) => {
			const event = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: data });
			view.contentDOM.dispatchEvent(event);
		},
		drop: (data, after) => {
			vi.spyOn(view, 'posAtCoords').mockReturnValue(indexOf(after) + after.length);
			view.contentDOM.dispatchEvent(dropEvent(data));
		},
		close: () => {
			unmount();
			return Promise.resolve();
		},
	};
};

describe.each([
	['rich', attachRich],
	['raw', attachRaw],
])('a file put in the %s editor', (_name, mount) => {
	it('goes in pasted as the markdown that links it, in place of the selection, as an edit', async () => {
		const { host, asked, open } = attachHost([fileAdded('a.pdf')]);
		const h = await mount('keep this out\n', host);

		h.select('this');
		h.paste(carrying(['a.pdf']));
		open();
		await vi.waitFor(() => {
			expect(h.markdown()).toBe('keep [a.pdf](a.pdf) out\n');
		});
		expect(asked).toEqual([{ name: 'a.pdf', pasted: true }]);
		expect(h.edits()).toBeGreaterThan(0);
	});

	it('goes in where it was dropped, as a file of its own name', async () => {
		const { host, asked, open } = attachHost([fileAdded('a.pdf')]);
		const h = await mount('one two\n', host);

		h.drop(carrying(['a.pdf']), 'one');
		open();
		await vi.waitFor(() => {
			expect(h.markdown()).toBe('one[a.pdf](a.pdf) two\n');
		});
		expect(asked).toEqual([{ name: 'a.pdf', pasted: false }]);
	});

	it('is not taken where the paste carries words of its own', async () => {
		const { host, asked } = attachHost([]);
		const h = await mount('xy\n', host);

		h.paste(carrying(['image.png'], 'Q1 120'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(asked).toEqual([]);
	});

	it('leaves the note as it was, and says why, where it is refused', async () => {
		const { host, told, open } = attachHost([{ state: 'refused', reason: 'too-large' }]);
		const h = await mount('xy\n', host);

		h.paste(carrying(['film.mov']));
		open();
		await vi.waitFor(() => {
			expect(told).toHaveLength(1);
		});
		expect(told[0]?.message).toBe(
			'film.mov is over 25 MB, the most a file beside a note can be.'
		);
		expect(h.markdown()).toBe('xy\n');
		expect(h.edits()).toBe(0);
	});

	it('says to add the rest again where the editor closed first, adding no more', async () => {
		const { host, asked, told, open } = attachHost([fileAdded('a.pdf'), fileAdded('b.pdf')]);
		const h = await mount('xy\n', host);

		h.paste(carrying(['a.pdf', 'b.pdf']));
		await vi.waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		await h.close();
		open();
		await vi.waitFor(() => {
			expect(told.map((problem) => problem.message)).toEqual([
				'The editor closed before 2 files could go in. Add them again to put them in.',
			]);
		});
		expect(asked.map((each) => each.name)).toEqual(['a.pdf']);
	});

	it('is waited for by whoever settles the editors', async () => {
		const { host, open } = attachHost([fileAdded('a.pdf')]);
		const h = await mount('xy\n', host);
		const settled = vi.fn();

		h.paste(carrying(['a.pdf']));
		void settleEditors().then(settled);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).not.toHaveBeenCalled();
		open();
		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalled();
		});
	});
});
