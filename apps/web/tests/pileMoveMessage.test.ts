import { describe, expect, it } from 'vitest';

import { pileMoveMessage } from '../src/components/ConnectButton.js';

/**
 * What the question before a connect says will move. Counted, so the user can
 * tell it is their notes being talked about, and without a count of nothing.
 */
describe('pileMoveMessage', () => {
	it('counts notebooks and notes both', () => {
		expect(pileMoveMessage({ notebooks: 2, notes: 5 }, 'Dropbox')).toBe(
			'Your 2 notebooks and 5 notes on this device will move into Dropbox and sync there. Cancel to keep them on this device only.'
		);
	});

	it('leaves out an empty count, and says "it" of one thing', () => {
		expect(pileMoveMessage({ notebooks: 1, notes: 0 }, 'OneDrive')).toBe(
			'Your 1 notebook on this device will move into OneDrive and sync there. Cancel to keep it on this device only.'
		);
		expect(pileMoveMessage({ notebooks: 0, notes: 3 }, 'Google Drive')).toBe(
			'Your 3 notes on this device will move into Google Drive and sync there. Cancel to keep them on this device only.'
		);
	});
});
