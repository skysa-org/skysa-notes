import { afterEach, describe, expect, it, vi } from 'vitest';

import { dropConnectCode, heldConnectCode, holdConnectCode } from '../src/store/connectCode.js';

/**
 * The code typed into the operator's connect gate, held for the tab so it
 * outlives the round trip through the provider's consent screen.
 */

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
	dropConnectCode();
});

describe('the connect code held for the tab', () => {
	it('is nothing until one is typed', () => {
		expect(heldConnectCode()).toBeUndefined();
	});

	it('is kept in session storage, which outlives a load and not the tab', () => {
		holdConnectCode('K7QM-2XRD');

		expect(sessionStorage.length).toBe(1);
		expect(heldConnectCode()).toBe('K7QM-2XRD');
	});

	it('is read trimmed, and a blank one is none', () => {
		holdConnectCode('  K7QM-2XRD ');
		expect(heldConnectCode()).toBe('K7QM-2XRD');

		holdConnectCode('   ');
		expect(heldConnectCode()).toBeUndefined();
		expect(sessionStorage.length).toBe(0);
	});

	it('is held to the bound the server takes', () => {
		holdConnectCode('x'.repeat(80));
		expect(heldConnectCode()).toBe('x'.repeat(64));
	});

	it('goes when it is dropped', () => {
		holdConnectCode('K7QM-2XRD');
		dropConnectCode();
		expect(heldConnectCode()).toBeUndefined();
	});

	it('is still there to send where the browser refuses storage', () => {
		const refusing = () => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
		vi.stubGlobal('sessionStorage', {
			getItem: refusing,
			setItem: refusing,
			removeItem: refusing,
		});

		holdConnectCode('K7QM-2XRD');
		expect(heldConnectCode()).toBe('K7QM-2XRD');

		dropConnectCode();
		expect(heldConnectCode()).toBeUndefined();
	});
});
