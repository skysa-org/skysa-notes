import { deriveTitle, UNTITLED_TITLE } from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { titleShown } from '../src/store/titles.js';

// Another language's words, to tell what is shown from what is kept.
vi.mock('../src/i18n/t.js', () => ({ t: (key: string) => `«${key}»` }));

describe('titleShown', () => {
	it('shows a note with nothing to take a name from in the app’s words', () => {
		expect(titleShown(deriveTitle({ body: '' }))).toBe('«notes.untitled»');
		expect(titleShown(UNTITLED_TITLE)).toBe('«notes.untitled»');
	});

	it('shows any other title as it is, a filename’s too', () => {
		expect(titleShown('Q3 plan')).toBe('Q3 plan');
		expect(titleShown(deriveTitle({ filename: 'untitled.md' }))).toBe('untitled');
	});
});
