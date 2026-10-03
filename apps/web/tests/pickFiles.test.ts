import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickFiles } from '../src/editor/pickFiles.js';

/**
 * The browser's own picker, through a file input clicked for the user (#187).
 * jsdom opens no picker: the input is found in the page and answered as the
 * browser would answer it.
 */

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const pickers = () => [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];

const picker = (): HTMLInputElement => {
	const [input] = pickers();
	if (input === undefined) throw new Error('no picker is open');
	return input;
};

/** The user chose `files` and pressed Open. */
const choose = (input: HTMLInputElement, files: File[]) => {
	Object.defineProperty(input, 'files', { value: files });
	input.dispatchEvent(new Event('change'));
};

const fileNamed = (name: string) => new File(['bytes'], name);

describe('picking files', () => {
	it('opens the picker at once, inside the press that asked for it', () => {
		const click = vi.spyOn(HTMLInputElement.prototype, 'click');

		void pickFiles();

		// Nothing awaited first: a browser opens its picker only then.
		expect(click).toHaveBeenCalledOnce();
		expect(picker().hidden).toBe(true);
		expect(picker().multiple).toBe(true);
	});

	it('answers the files chosen, and takes its input out of the page', async () => {
		const asked = pickFiles();
		const files = [fileNamed('a.pdf'), fileNamed('b.png')];

		choose(picker(), files);

		expect(await asked).toEqual(files);
		expect(pickers()).toEqual([]);
	});

	it('offers what it is asked to, or anything', () => {
		void pickFiles({ accept: 'image/*' });
		expect(picker().getAttribute('accept')).toBe('image/*');
		picker().dispatchEvent(new Event('cancel'));

		void pickFiles();
		expect(picker().hasAttribute('accept')).toBe(false);
	});

	it('answers nothing when the picker is closed without a choice', async () => {
		const asked = pickFiles();

		picker().dispatchEvent(new Event('cancel'));

		expect(await asked).toEqual([]);
		expect(pickers()).toEqual([]);
	});

	it('answers once, whatever the input says after', async () => {
		const asked = pickFiles();
		const input = picker();

		input.dispatchEvent(new Event('cancel'));
		choose(input, [fileNamed('late.pdf')]);

		expect(await asked).toEqual([]);
	});

	// Chrome queues a picker asked for while another is open: pressed twice,
	// the first picker's choice is still the user's.
	it('keeps each pick its own, one asked for while another is open included', async () => {
		const first = pickFiles();
		const second = pickFiles();
		const [one, two] = pickers();
		if (one === undefined || two === undefined) throw new Error('two pickers expected');

		const chosen = [fileNamed('a.pdf')];
		choose(one, chosen);
		expect(await first).toEqual(chosen);
		two.dispatchEvent(new Event('cancel'));
		expect(await second).toEqual([]);
		expect(pickers()).toEqual([]);
	});

	it('puts its input in the document it is given', () => {
		const other = document.implementation.createHTMLDocument('other');

		void pickFiles({ within: other });

		expect(pickers()).toEqual([]);
		expect(other.querySelectorAll('input[type="file"]')).toHaveLength(1);
		other.querySelector('input')?.dispatchEvent(new Event('cancel'));
	});
});
