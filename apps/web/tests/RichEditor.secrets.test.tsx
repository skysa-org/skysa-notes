import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichEditor } from '../src/editor/RichEditor.js';
import { fakeHost, fence, openedIn, sealed } from './secretHostFake.js';

/**
 * A secret's panel as the rich editor goes, with the real editor: the note
 * left, or the other editor chosen. `secretBlock.test.ts` drives the editor
 * without React, and so without whatever takes it away.
 */

afterEach(cleanup);

/** `words` in the open panel, as typing them leaves it; `composing`, mid-character. */
const type = (words: string, { composing = false }: { composing?: boolean } = {}) => {
	const field = document.querySelector<HTMLTextAreaElement>('.secret-words');
	if (field === null) throw new Error('no panel');
	field.value = words;
	field.setSelectionRange(words.length, words.length);
	field.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
};

describe('the rich editor going', () => {
	it('keeps a word an input method is still composing in a secret’s panel', async () => {
		const fake = fakeHost();
		const onUserEdit = vi.fn();
		const view = render(
			<RichEditor
				noteId="a"
				body={`${fence(sealed('pin'))}\n`}
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
				secrets={fake.host}
			/>
		);
		const reported = () => openedIn(String(onUserEdit.mock.lastCall?.[0] ?? ''));

		const reveal = await waitFor(() => {
			const found = [...document.querySelectorAll('button')].find(
				(button) => button.textContent === 'Reveal'
			);
			if (found === undefined) throw new Error('no Reveal');
			return found;
		});
		reveal.click();
		await waitFor(() => {
			expect(document.querySelector('.secret-words')).not.toBeNull();
		});
		type('pin 1234');
		type('pin 1234 hunter2', { composing: true });
		expect(reported()).toEqual(['pin 1234']);

		view.unmount();

		expect(reported()).toEqual(['pin 1234 hunter2']);
	});
});
