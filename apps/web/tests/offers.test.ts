import { describe, expect, it, vi } from 'vitest';

import { createOffers } from '../src/editor/offers.js';

describe('the editor open now', () => {
	it('is none until one offers itself, and none again once it has gone', () => {
		const offers = createOffers<string>();
		expect(offers.current()).toBeUndefined();

		const withdraw = offers.offer('rich');
		expect(offers.current()).toBe('rich');

		withdraw();
		expect(offers.current()).toBeUndefined();
	});

	it('is the new one, while the old one has yet to go and after it has', () => {
		const offers = createOffers<string>();
		const old = offers.offer('rich');

		offers.offer('raw');
		expect(offers.current()).toBe('raw');

		old();
		expect(offers.current()).toBe('raw');
	});

	it('goes back to the live one when one let go of offers itself late, and goes', () => {
		const offers = createOffers<string>();
		offers.offer('raw');

		const late = offers.offer('rich being built');
		late();

		expect(offers.current()).toBe('raw');
	});

	it('takes one item offered twice away once for each offer', () => {
		const offers = createOffers<string>();
		const first = offers.offer('rich');
		offers.offer('raw');
		offers.offer('rich');
		expect(offers.current()).toBe('rich');

		first();

		expect(offers.current()).toBe('rich');
	});

	it('tells its listeners of each change, and not of a second withdrawal', () => {
		const offers = createOffers<string>();
		const listener = vi.fn();
		offers.subscribe(listener);

		const withdraw = offers.offer('rich');
		expect(listener).toHaveBeenCalledTimes(1);
		withdraw();
		expect(listener).toHaveBeenCalledTimes(2);
		withdraw();
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
