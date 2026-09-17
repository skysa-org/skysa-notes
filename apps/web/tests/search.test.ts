import { ROOT } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { folderFromSearch, folderToSearch, parseSearch } from '../src/routes/search.js';

/**
 * The URL is where the open folder survives a reload, so a folder that cannot
 * make the round trip is a row the user can click and never reach. The root is
 * the one at risk: it is `''`, which an empty query string cannot tell apart
 * from an absent one.
 */

describe('parseSearch', () => {
	it('takes a folder and a note', () => {
		expect(parseSearch({ folder: 'work', note: 'n1' })).toEqual({ folder: 'work', note: 'n1' });
	});

	it('drops an empty value, which says nothing', () => {
		expect(parseSearch({ folder: '', note: '' })).toEqual({});
	});

	it('drops anything that is not a string', () => {
		expect(parseSearch({ folder: 7, note: { id: 'n1' } })).toEqual({});
	});

	it('ignores what it does not know about', () => {
		expect(parseSearch({ folder: 'work', spurious: 'x' })).toEqual({ folder: 'work' });
	});

	it('takes the outcome of connecting storage only when it is one the API sends', () => {
		expect(parseSearch({ connect: 'ok' })).toEqual({ connect: 'ok' });
		expect(parseSearch({ connect: 'denied' })).toEqual({ connect: 'denied' });
		expect(parseSearch({ connect: 'pwned' })).toEqual({});
		expect(parseSearch({ connect: ['ok'] })).toEqual({});
	});
});

describe('the root folder through the URL', () => {
	it('survives the round trip', () => {
		// The point of the sentinel. Written plainly, `folder=` would be dropped
		// by `parseSearch` and the loose notes would be unreachable by link,
		// bookmark or reload.
		const search = parseSearch({ folder: folderToSearch(ROOT) });
		expect(folderFromSearch(search.folder)).toBe(ROOT);
	});

	it('is not spelled as an empty value', () => {
		expect(folderToSearch(ROOT)).not.toBe('');
	});

	it('leaves a notebook path alone in both directions', () => {
		expect(folderToSearch('work/meetings')).toBe('work/meetings');
		expect(folderFromSearch('work/meetings')).toBe('work/meetings');
	});

	it('reads an absent folder as nothing open, not as the root', () => {
		expect(folderFromSearch(undefined)).toBeUndefined();
	});
});
