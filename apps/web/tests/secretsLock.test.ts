import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecretsLock, IDLE_MS, type LockTarget } from '../src/secrets/lock.js';
import type { UnlockedKeys } from '../src/store/secretKeys.js';

/**
 * A tab's unlocked sources (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * locked when the page is hidden, unless the app hid it, and after 30 s with
 * nothing done in it; their keys filled with zeros as they go.
 */

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** The page: hidden or not, and its listeners, which the test fires. */
const page = () => {
	const state = { visibility: 'visible' as DocumentVisibilityState };
	const listeners = new Map<string, Set<() => void>>();
	const target: LockTarget = {
		get visibilityState() {
			return state.visibility;
		},
		addEventListener: (type, listener) => {
			listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
		},
		removeEventListener: (type, listener) => {
			listeners.get(type)?.delete(listener);
		},
	};
	const fire = (type: string) => {
		listeners.get(type)?.forEach((listener) => {
			listener();
		});
	};
	const hide = () => {
		state.visibility = 'hidden';
		fire('visibilitychange');
	};
	const show = () => {
		state.visibility = 'visible';
		fire('visibilitychange');
	};
	const listening = () => [...listeners.values()].reduce((count, set) => count + set.size, 0);
	return { target, fire, hide, show, listening };
};

const keysFor = (connectionId: string, fill = 7): UnlockedKeys => ({
	connectionId,
	recipient: 'age1…',
	identities: [new Uint8Array(32).fill(fill), new Uint8Array(32).fill(fill + 1)],
	sealing: {} as CryptoKey,
	sealedAs: new ArrayBuffer(12),
});

const zeroed = (keys: UnlockedKeys) =>
	keys.identities.every((identity) => identity.every((byte) => byte === 0));

const setup = () => {
	const p = page();
	const lock = createSecretsLock({ target: p.target });
	const heard = vi.fn();
	lock.subscribe(heard);
	return { ...p, lock, heard };
};

describe('holding keys', () => {
	it('holds a source unlocked until it is locked, and then fills its keys with zeros', () => {
		const h = setup();
		const keys = keysFor('c1');
		h.lock.hold(keys);
		expect(h.lock.isUnlocked('c1')).toBe(true);
		expect(h.lock.keys('c1')).toBe(keys);

		h.lock.lock('c1');

		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(h.lock.keys('c1')).toBeUndefined();
		expect(zeroed(keys)).toBe(true);
		expect(h.heard).toHaveBeenCalledTimes(2);
	});

	it('locks one source, or every one', () => {
		const h = setup();
		const one = keysFor('c1');
		const two = keysFor('c2');
		h.lock.hold(one);
		h.lock.hold(two);

		h.lock.lock('c1');
		expect([h.lock.isUnlocked('c1'), h.lock.isUnlocked('c2')]).toEqual([false, true]);
		expect(zeroed(two)).toBe(false);

		h.lock.lock();
		expect(h.lock.isUnlocked('c2')).toBe(false);
		expect(zeroed(two)).toBe(true);
	});

	it('fills the keys it held for a source with zeros when it is given others', () => {
		const h = setup();
		const before = keysFor('c1', 3);
		h.lock.hold(before);
		h.lock.hold(keysFor('c1', 5));
		expect(zeroed(before)).toBe(true);
		expect(h.lock.keys('c1')?.identities[0]?.[0]).toBe(5);
	});

	it('keeps what the keys it is given hold of the ones it held', () => {
		const h = setup();
		const before = keysFor('c1', 3);
		const [shared] = before.identities;
		h.lock.hold(before);
		h.lock.hold({ ...before, identities: [shared as Uint8Array] });
		expect(h.lock.keys('c1')?.identities[0]?.[0]).toBe(3);
		expect(before.identities[1]?.[0]).toBe(0);
	});

	it('says nothing of a lock with nothing to lock', () => {
		const h = setup();
		h.lock.lock();
		h.lock.lock('c1');
		expect(h.heard).not.toHaveBeenCalled();
	});

	it('listens to the page only while something is unlocked', () => {
		const h = setup();
		expect(h.listening()).toBe(0);
		h.lock.hold(keysFor('c1'));
		expect(h.listening()).toBeGreaterThan(0);
		h.lock.lock();
		expect(h.listening()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('locking on its own', () => {
	it('locks when the page is hidden', () => {
		const h = setup();
		const keys = keysFor('c1');
		h.lock.hold(keys);
		h.hide();
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(zeroed(keys)).toBe(true);
	});

	it('locks at once keys it is given while the page is hidden, but not while a prompt of the app’s own is open', async () => {
		const h = setup();
		h.hide();
		const keys = keysFor('c1');
		h.lock.hold(keys);
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(zeroed(keys)).toBe(true);

		const answer = Promise.withResolvers<void>();
		const asked = h.lock.prompting(async () => {
			h.lock.hold(keysFor('c2'));
			expect(h.lock.isUnlocked('c2')).toBe(true);
			await answer.promise;
		});
		answer.resolve();
		await asked;
		expect(h.lock.isUnlocked('c2')).toBe(false);
	});

	it('does not for a prompt of the app’s own, and does once it closes on a hidden page', async () => {
		const h = setup();
		h.lock.hold(keysFor('c1'));
		const answer = Promise.withResolvers<string>();

		const asked = h.lock.prompting(() => answer.promise);
		h.hide();
		expect(h.lock.isUnlocked('c1')).toBe(true);
		h.show();
		answer.resolve('done');
		expect(await asked).toBe('done');
		expect(h.lock.isUnlocked('c1')).toBe(true);

		const again = Promise.withResolvers<void>();
		const second = h.lock.prompting(() => again.promise);
		h.hide();
		again.resolve();
		await second;
		expect(h.lock.isUnlocked('c1')).toBe(false);
	});

	it('locks after 30 s with nothing done in the page', () => {
		const h = setup();
		h.lock.hold(keysFor('c1'));
		vi.advanceTimersByTime(IDLE_MS - 1);
		expect(h.lock.isUnlocked('c1')).toBe(true);
		vi.advanceTimersByTime(1);
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(IDLE_MS).toBe(30_000);
	});

	it.each(['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel', 'scroll'])(
		'counts a %s as something done',
		(type) => {
			const h = setup();
			h.lock.hold(keysFor('c1'));
			vi.advanceTimersByTime(IDLE_MS - 1000);
			h.fire(type);
			vi.advanceTimersByTime(IDLE_MS - 1);
			expect(h.lock.isUnlocked('c1')).toBe(true);
			vi.advanceTimersByTime(1);
			expect(h.lock.isUnlocked('c1')).toBe(false);
		}
	);

	it('waits out a prompt of the app’s own however long it takes, and counts its answer as something done', async () => {
		const h = setup();
		h.lock.hold(keysFor('c1'));
		const answer = Promise.withResolvers<void>();
		const asked = h.lock.prompting(() => answer.promise);

		// Answered between two of the lock's looks at the page.
		vi.advanceTimersByTime(3 * IDLE_MS + 10_000);
		expect(h.lock.isUnlocked('c1')).toBe(true);
		answer.resolve();
		await asked;

		vi.advanceTimersByTime(IDLE_MS - 1);
		expect(h.lock.isUnlocked('c1')).toBe(true);
		vi.advanceTimersByTime(IDLE_MS);
		expect(h.lock.isUnlocked('c1')).toBe(false);
	});

	it('gives a second source its own 30 s from when it was unlocked', () => {
		const h = setup();
		h.lock.hold(keysFor('c1'));
		vi.advanceTimersByTime(IDLE_MS - 1000);
		h.lock.hold(keysFor('c2'));
		vi.advanceTimersByTime(IDLE_MS - 1);
		expect(h.lock.isUnlocked('c2')).toBe(true);
		vi.advanceTimersByTime(1);
		expect(h.lock.isUnlocked('c2')).toBe(false);
	});
});
