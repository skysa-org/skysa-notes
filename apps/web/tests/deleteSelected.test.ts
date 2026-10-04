import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * A delete a phone's keyboard asks for with an input event rather than a key,
 * while a picture or a chip is selected whole (`editor/deleteSelected.ts`).
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

const BODY = 'A ![cat](cat.png) and [a.zip](a.zip) b.\n';

const mount = async () => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body: BODY, onUserEdit }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	const at = (type: string) => {
		const found = { current: -1 };
		view.state.doc.descendants((node, pos) => {
			if (found.current === -1 && node.type.name === type) found.current = pos;
		});
		return found.current;
	};
	return {
		view,
		onUserEdit,
		at,
		markdown: () => editor.action(currentMarkdown),
		select: (type: string) => {
			view.dispatch(
				view.state.tr.setSelection(NodeSelection.create(view.state.doc, at(type)))
			);
		},
		/** What a phone's keyboard sends: no key, an input event. */
		input: (inputType: string, init: InputEventInit = {}) => {
			const event = new InputEvent('beforeinput', {
				inputType,
				bubbles: true,
				cancelable: true,
				...init,
			});
			view.dom.dispatchEvent(event);
			return event;
		},
	};
};

describe('a delete from a keyboard with no keys', () => {
	it.each([
		['picture', 'image', 'A  and [a.zip](a.zip) b.\n'],
		['chip', 'attachment', 'A ![cat](cat.png) and  b.\n'],
	])(
		'takes a %s selected whole out of the note, as the user’s edit',
		async (_what, type, after) => {
			const mounted = await mount();
			mounted.select(type);

			const event = mounted.input('deleteContentBackward');

			expect(event.defaultPrevented).toBe(true);
			expect(mounted.at(type)).toBe(-1);
			expect(mounted.markdown()).toBe(after);
			expect(mounted.onUserEdit).toHaveBeenLastCalledWith(after);
		}
	);

	it.each(['deleteContentForward', 'deleteWordBackward', 'deleteSoftLineBackward'])(
		'takes %s as a delete too',
		async (inputType) => {
			const mounted = await mount();
			mounted.select('image');

			mounted.input(inputType);

			expect(mounted.at('image')).toBe(-1);
		}
	);

	it.each([
		['words typed over it, which the browser types', 'insertText', { data: 'x' }],
		// No keyboard is known to spell a delete so, and one that sent it as a
		// selection settled would take a picture just tapped.
		['nothing typed over it', 'insertText', { data: '' }],
		['a cut, which is the clipboard’s', 'deleteByCut', {}],
		['a drag, which is the drop’s', 'deleteByDrag', {}],
	])('leaves %s alone', async (_what, inputType, init) => {
		const mounted = await mount();
		mounted.select('image');
		const before = mounted.view.state.doc;

		const event = mounted.input(inputType, init);

		expect(event.defaultPrevented).toBe(false);
		expect(mounted.view.state.doc.eq(before)).toBe(true);
	});

	it('leaves a delete alone with no node selected, where the browser and the keymap do it', async () => {
		const mounted = await mount();
		mounted.view.dispatch(
			mounted.view.state.tr.setSelection(TextSelection.create(mounted.view.state.doc, 2))
		);
		const before = mounted.view.state.doc;

		const event = mounted.input('deleteContentBackward');

		expect(event.defaultPrevented).toBe(false);
		expect(mounted.view.state.doc.eq(before)).toBe(true);
	});

	it('leaves one the browser will not let be cancelled, so it is never made twice', async () => {
		const mounted = await mount();
		mounted.select('image');
		const before = mounted.view.state.doc;

		mounted.view.dom.dispatchEvent(
			new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true })
		);

		expect(mounted.view.state.doc.eq(before)).toBe(true);
	});
});
