import { MAX_CONNECT_CODE } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	connectCodeHeldUntil,
	dropConnectCode,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
	holdConnectCode,
	watchConnectCode,
} from '../src/store/connectCode.js';

/**
 * The code the operator's policy accepted at the connect gate, held for as
 * long as the policy said, so it outlives the round trip through the
 * provider's consent screen and a closed tab, and nothing after that.
 */

const NOW = Date.parse('2026-09-29T15:00:00Z');

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
	dropConnectCode();
});

describe('the connect code held for as long as it is good', () => {
	it('is nothing until one is accepted', () => {
		expect(heldConnectCode()).toBeUndefined();
		expect(connectCodeHeldUntil()).toBeUndefined();
	});

	it('is kept in local storage, with the time it stops being good', () => {
		holdConnectCode('K7QM-2XRD', 900, NOW);

		expect(localStorage.length).toBe(1);
		expect(heldConnectCode(NOW + 1000)).toBe('K7QM-2XRD');
		expect(connectCodeHeldUntil(NOW)).toBe(NOW + 900_000);
	});

	it('is let go of once that time has come', () => {
		holdConnectCode('K7QM-2XRD', 900, NOW);

		expect(heldConnectCode(NOW + 899_999)).toBe('K7QM-2XRD');
		expect(heldConnectCode(NOW + 900_000)).toBeUndefined();
		// And gone from storage, not only unread.
		expect(localStorage.length).toBe(0);
	});

	it('is held trimmed, and a blank one, or one good for no time, is none', () => {
		holdConnectCode('  K7QM-2XRD ', 900, NOW);
		expect(heldConnectCode(NOW)).toBe('K7QM-2XRD');

		holdConnectCode('   ', 900, NOW);
		expect(heldConnectCode(NOW)).toBeUndefined();
		expect(localStorage.length).toBe(0);

		holdConnectCode('K7QM-2XRD', 0, NOW);
		expect(heldConnectCode(NOW)).toBeUndefined();
	});

	it('is held to the bound the server takes', () => {
		holdConnectCode('x'.repeat(MAX_CONNECT_CODE + 16), 900, NOW);
		expect(heldConnectCode(NOW)).toBe('x'.repeat(MAX_CONNECT_CODE));
	});

	it('goes when it is dropped', () => {
		holdConnectCode('K7QM-2XRD', 900, NOW);
		dropConnectCode();
		expect(heldConnectCode(NOW)).toBeUndefined();
	});

	it('reads anything it did not write as nothing', () => {
		for (const stored of ['K7QM-2XRD', '{"code":"K7QM-2XRD"}', '{"code":7,"until":1}', '[']) {
			localStorage.setItem('skysa.connectCode', stored);
			expect(heldConnectCode(NOW)).toBeUndefined();
		}
	});

	it('is still there to send where the browser refuses storage, until its time', () => {
		const refusing = () => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
		vi.stubGlobal('localStorage', {
			getItem: refusing,
			setItem: refusing,
			removeItem: refusing,
		});

		holdConnectCode('K7QM-2XRD', 900, NOW);
		expect(heldConnectCode(NOW)).toBe('K7QM-2XRD');
		expect(heldConnectCode(NOW + 900_000)).toBeUndefined();

		holdConnectCode('K7QM-2XRD', 900, NOW);
		dropConnectCode();
		expect(heldConnectCode(NOW)).toBeUndefined();
	});
});

describe('what the policy gives to hold in place of a code', () => {
	const PASS = `dt1.${'Ab_-'.repeat(40)}`;

	it('is held in place of what was typed, for as long as the policy said, and never shown', () => {
		holdAcceptedCode('K7QM-2XRD', { expiresIn: 180 * 86_400, hold: PASS }, NOW);

		expect(heldConnectCode(NOW)).toBe(PASS);
		expect(connectCodeHeldUntil(NOW)).toBe(NOW + 180 * 86_400_000);
		expect(heldConnectCodeShown(NOW)).toBe(false);
	});

	it('leaves a code the policy gave nothing for held as typed, and shown', () => {
		holdAcceptedCode(' K7QM-2XRD ', { expiresIn: 900 }, NOW);

		expect(heldConnectCode(NOW)).toBe('K7QM-2XRD');
		expect(heldConnectCodeShown(NOW)).toBe(true);
	});

	it('stays unshown when it is asked about again and kept as it is', () => {
		holdAcceptedCode('K7QM-2XRD', { expiresIn: 60, hold: PASS }, NOW);
		holdAcceptedCode(PASS, { expiresIn: 120 }, NOW);

		expect(heldConnectCode(NOW)).toBe(PASS);
		expect(connectCodeHeldUntil(NOW)).toBe(NOW + 120_000);
		expect(heldConnectCodeShown(NOW)).toBe(false);
	});

	it('is replaced by a code typed after it, which is shown', () => {
		holdAcceptedCode('K7QM-2XRD', { expiresIn: 60, hold: PASS }, NOW);
		holdAcceptedCode('W3TB-9HQP', { expiresIn: 900 }, NOW);

		expect(heldConnectCode(NOW)).toBe('W3TB-9HQP');
		expect(heldConnectCodeShown(NOW)).toBe(true);
	});

	it('reads a code kept before there were holds as typed', () => {
		localStorage.setItem(
			'skysa.connectCode',
			JSON.stringify({ code: 'K7QM-2XRD', until: NOW + 60_000 })
		);

		expect(heldConnectCode(NOW)).toBe('K7QM-2XRD');
		expect(heldConnectCodeShown(NOW)).toBe(true);
	});

	it('tells whoever is watching each time what is held changes, until they stop', () => {
		const told = vi.fn();
		const stop = watchConnectCode(told);

		holdAcceptedCode('K7QM-2XRD', { expiresIn: 60, hold: PASS }, NOW);
		dropConnectCode();
		stop();
		holdConnectCode('K7QM-2XRD', 900, NOW);

		expect(told).toHaveBeenCalledTimes(2);
	});
});
