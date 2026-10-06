import { describe, expect, it } from 'vitest';

import { parseSearch } from '../src/routes/search.js';

describe('parseSearch', () => {
	it('refuses a folder and a note, which the hash and the history entry carry now', () => {
		// A link from before the move still has them, and nothing must read them
		// as a place: the same names can mean another notebook today.
		expect(parseSearch({ folder: 'work', note: 'n1' })).toEqual({});
	});

	it('ignores what it does not know about', () => {
		expect(parseSearch({ connect: 'ok', spurious: 'x' })).toEqual({ connect: 'ok' });
	});

	it('takes the outcome of connecting storage only when it is one the API sends', () => {
		expect(parseSearch({ connect: 'ok' })).toEqual({ connect: 'ok' });
		expect(parseSearch({ connect: 'denied' })).toEqual({ connect: 'denied' });
		expect(parseSearch({ connect: 'expired' })).toEqual({ connect: 'expired' });
		expect(parseSearch({ connect: 'pwned' })).toEqual({});
		expect(parseSearch({ connect: ['ok'] })).toEqual({});
	});

	it('takes a request for the code field, and nothing else under its name', () => {
		expect(parseSearch({ enter: 'code' })).toEqual({ enter: 'code' });
		expect(parseSearch({ enter: 'note' })).toEqual({});
		expect(parseSearch({ enter: ['code'] })).toEqual({});
	});

	it('takes a share only by an id the service worker could have made', () => {
		const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
		expect(parseSearch({ share: id })).toEqual({ share: id });
		expect(parseSearch({ share: 'x' })).toEqual({});
		expect(parseSearch({ share: `${id}/0` })).toEqual({});
		expect(parseSearch({ share: [id] })).toEqual({});
	});

	it('takes the kind of refusal only when it is one a policy can give', () => {
		expect(parseSearch({ connect: 'refused', code: 'lapsed' })).toEqual({
			connect: 'refused',
			code: 'lapsed',
		});
		// Free text is exactly what the code exists to keep out of the URL.
		expect(parseSearch({ connect: 'refused', code: 'Your plan ended' })).toEqual({
			connect: 'refused',
		});
		expect(parseSearch({ code: ['lapsed'] })).toEqual({});
	});

	/**
	 * `toEqual` cannot see this, which is why the tests above passed while the
	 * app was handed raw values: the router spreads this result over the raw
	 * query, so a refused key has to be present and `undefined` to override it.
	 * `tests/routes.search.test.tsx` holds the same line through the real router.
	 */
	it('overrides what it refuses instead of leaving it out', () => {
		const refused = parseSearch({
			folder: [1],
			note: { a: 1 },
			connect: 'signin',
			code: 'x',
			enter: 'x',
			share: '../x',
		});
		expect(refused).toStrictEqual({
			folder: undefined,
			note: undefined,
			connect: undefined,
			code: undefined,
			enter: undefined,
			share: undefined,
		});
		expect({ note: { a: 1 }, ...refused }.note).toBeUndefined();
	});
});
