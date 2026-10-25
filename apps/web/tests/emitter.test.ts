import { describe, expect, it, vi } from 'vitest';

import { createEmitter, createStore } from '../src/store/emitter.js';

describe('createEmitter', () => {
	it('tells each listener, in the order they began, until it stops', () => {
		const changes = createEmitter();
		const heard: string[] = [];
		const stopFirst = changes.subscribe(() => heard.push('first'));
		changes.subscribe(() => heard.push('second'));

		changes.emit();
		stopFirst();
		changes.emit();

		expect(heard).toEqual(['first', 'second', 'second']);
	});

	it('lets a listener that throws reach whoever made the change', () => {
		const changes = createEmitter();
		const after = vi.fn();
		changes.subscribe(() => {
			throw new Error('listener');
		});
		changes.subscribe(after);

		expect(() => {
			changes.emit();
		}).toThrow('listener');
		expect(after).not.toHaveBeenCalled();
	});
});

describe('createStore', () => {
	it('holds what it is set to, and says so', () => {
		const store = createStore(1);
		const listener = vi.fn();
		store.subscribe(listener);

		store.set(2);

		expect(store.get()).toBe(2);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('says nothing of a value the same as the one it holds', () => {
		const store = createStore({ a: 1 }, (held, next) => held.a === next.a);
		const listener = vi.fn();
		store.subscribe(listener);
		const before = store.get();

		store.set({ a: 1 });

		expect(store.get()).toBe(before);
		expect(listener).not.toHaveBeenCalled();
	});

	it('compares by identity unless told otherwise', () => {
		const store = createStore<object>({});
		const listener = vi.fn();
		store.subscribe(listener);

		store.set(store.get());
		store.set({});

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
