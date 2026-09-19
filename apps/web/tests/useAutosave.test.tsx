import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AUTOSAVE_RETRY_MS,
	type SaveContext,
	type Unstored,
	useAutosave,
} from '../src/editor/useAutosave.js';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('useAutosave', () => {
	it('writes once the debounce window has passed', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('first');
		});
		expect(save).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(save).toHaveBeenCalledExactlyOnceWith('first');
	});

	it('collapses a burst of typing into one write', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
			vi.advanceTimersByTime(500);
			result.current.change('ab');
			vi.advanceTimersByTime(500);
			result.current.change('abc');
			vi.advanceTimersByTime(2000);
		});

		expect(save).toHaveBeenCalledExactlyOnceWith('abc');
	});

	it('flushes on demand', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('pending');
			result.current.flush();
		});

		expect(save).toHaveBeenCalledExactlyOnceWith('pending');
	});

	it('does not write again when there is nothing pending', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('once');
			result.current.flush();
			result.current.flush();
			vi.advanceTimersByTime(5000);
		});

		expect(save).toHaveBeenCalledTimes(1);
	});

	it('flushes a pending edit before a different note takes over', () => {
		const save = vi.fn();
		const { result, rerender } = renderHook(
			({ key }: { key: string }) => useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'note-a' } }
		);

		act(() => {
			result.current.change('edit to note a');
		});
		rerender({ key: 'note-b' });

		expect(save).toHaveBeenCalledExactlyOnceWith('edit to note a');
	});

	it('flushes on unmount, so closing the editor cannot strand an edit', () => {
		const save = vi.fn();
		const { result, unmount } = renderHook(() =>
			useAutosave({ key: 'a', save, delayMs: 2000 })
		);

		act(() => {
			result.current.change('unsaved');
		});
		unmount();

		expect(save).toHaveBeenCalledExactlyOnceWith('unsaved');
	});

	it('flushes when the tab is hidden, which a closing PWA does instead of unmounting', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('unsaved');
		});

		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(save).toHaveBeenCalledExactlyOnceWith('unsaved');
	});

	it('ignores a visibility change back to visible', () => {
		const save = vi.fn();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('unsaved');
		});

		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(save).not.toHaveBeenCalled();
	});

	it('uses the latest save callback, not the one it mounted with', () => {
		const first = vi.fn();
		const second = vi.fn();
		const { result, rerender } = renderHook(
			({ save }: { save: (value: string) => void }) =>
				useAutosave({ key: 'a', save, delayMs: 2000 }),
			{ initialProps: { save: first } }
		);

		act(() => {
			result.current.change('value');
		});
		rerender({ save: second });
		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledExactlyOnceWith('value');
	});

	it('saves the pending value first when the next one does not stand for it', () => {
		const save = vi.fn();
		const { result } = renderHook(() =>
			useAutosave<{ body: string; base: number }>({
				key: 'a',
				save,
				delayMs: 2000,
				supersedes: (next, pending) => next.base === pending.base,
			})
		);

		act(() => {
			result.current.change({ body: 'a', base: 1 });
			result.current.change({ body: 'ab', base: 1 });
		});
		expect(save).not.toHaveBeenCalled();

		act(() => {
			result.current.change({ body: 'x', base: 2 });
		});
		expect(save).toHaveBeenCalledExactlyOnceWith({ body: 'ab', base: 1 });

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(save).toHaveBeenLastCalledWith({ body: 'x', base: 2 });
		expect(save).toHaveBeenCalledTimes(2);
	});
});

/** Let the debounce pass, and whatever the write it starts leads to. */
const pass = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

/** A `save` the test settles by hand, recording what it was given, in order. */
const manualSave = <T,>() => {
	const calls: {
		value: T;
		context: SaveContext | undefined;
		resolve: () => void;
		reject: (error: Error) => void;
	}[] = [];
	const save = (value: T, context?: SaveContext) =>
		new Promise<void>((resolve, reject) => {
			calls.push({ value, context, resolve, reject });
		});
	return { calls, save, values: () => calls.map((call) => call.value) };
};

const settleCall = (end: (() => void) | undefined) =>
	act(async () => {
		end?.();
		await Promise.resolve();
	});

interface Based {
	body: string;
	base: number;
}
const sameBase = (next: Based, pending: Based) => next.base === pending.base;

describe('useAutosave, when a write fails', () => {
	it('keeps the edit, says so, and writes the newest text once when a write next works', async () => {
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('VersionError'))
			.mockResolvedValue(undefined);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));
		expect(result.current.failing).toBe(false);

		act(() => {
			result.current.change('a');
		});
		await pass(2000);
		expect(save).toHaveBeenCalledExactlyOnceWith('a');
		expect(result.current.failing).toBe(true);

		act(() => {
			result.current.change('ab');
		});
		await pass(2000);

		// Once, and the newer text: the older one it stands for is not written
		// first, and certainly not after.
		expect(save.mock.calls).toEqual([['a'], ['ab']]);
		expect(result.current.failing).toBe(false);

		await pass(AUTOSAVE_RETRY_MS * 3);
		expect(save).toHaveBeenCalledTimes(2);
	});

	it('tries again by itself, slowly, and stops once it is written', async () => {
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('only');
		});
		await pass(2000);
		expect(save).toHaveBeenCalledTimes(1);

		// Not a loop: nothing happens until the wait is up.
		await pass(AUTOSAVE_RETRY_MS - 1);
		expect(save).toHaveBeenCalledTimes(1);
		await pass(1);
		expect(save).toHaveBeenCalledTimes(2);
		expect(result.current.failing).toBe(true);

		await pass(AUTOSAVE_RETRY_MS);
		// Nothing newer was ever issued for it, so it goes as the note's body.
		expect(save.mock.calls).toEqual([['only'], ['only'], ['only']]);
		expect(result.current.failing).toBe(false);

		await pass(AUTOSAVE_RETRY_MS * 3);
		expect(save).toHaveBeenCalledTimes(3);
	});

	it('calls save there and then on a flush, even with a write still out', () => {
		const { save, values } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
			result.current.flush();
			result.current.change('ab');
			result.current.flush();
			// Still inside the same tick: what `pagehide`, a mode switch and a
			// delete all rely on. The store orders the two; the hook does not.
			expect(values()).toEqual(['a', 'ab']);
		});
	});

	it('writes what is pending before it retries, and never the older text after it', async () => {
		const { calls, save, values } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 60_000 }));

		act(() => {
			result.current.change('v1');
			result.current.flush();
		});
		await settleCall(() => calls[0]?.reject(new Error('no')));
		expect(result.current.failing).toBe(true);

		// Typing on with no pause long enough for the debounce, as the retry
		// comes due.
		act(() => {
			result.current.change('v1 and more');
		});
		await pass(AUTOSAVE_RETRY_MS);
		expect(values()).toEqual(['v1', 'v1 and more']);

		await settleCall(calls[1]?.resolve);
		await pass(AUTOSAVE_RETRY_MS * 3);

		expect(values()).toEqual(['v1', 'v1 and more']);
		expect(result.current.failing).toBe(false);
	});

	it('lets an older write that fails late go, when a newer one is already stored', async () => {
		const { calls, save, values } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
			result.current.flush();
			result.current.change('ab');
			result.current.flush();
		});
		await settleCall(calls[1]?.resolve);
		await settleCall(() => calls[0]?.reject(new Error('no')));
		await pass(AUTOSAVE_RETRY_MS * 3);

		expect(values()).toEqual(['a', 'ab']);
		expect(result.current.failing).toBe(false);
	});

	it('attempts every held edit in one settle, whatever becomes of the ones before', async () => {
		const save = vi.fn<(value: Based, context?: SaveContext) => Promise<void>>((value) =>
			value.base === 1 ? Promise.reject(new Error('no')) : Promise.resolve()
		);
		const { result } = renderHook(() =>
			useAutosave<Based>({ key: 'a', save, delayMs: 2000, supersedes: sameBase })
		);

		act(() => {
			result.current.change({ body: 'a', base: 1 });
		});
		await pass(2000);
		expect(result.current.failing).toBe(true);

		// Typed into a body a pull brought in. It does not stand for the edit
		// that failed, which is kept — and its failing again does not stop this
		// one being written before `settle` says it is done.
		act(() => {
			result.current.change({ body: 'x', base: 2 });
		});
		await act(async () => {
			await result.current.settle();
		});

		expect(save.mock.calls.map(([value]) => value)).toEqual([
			{ body: 'a', base: 1 },
			{ body: 'x', base: 2 },
			{ body: 'a', base: 1 },
		]);
		// The older one is handed over as displaced: the store keeps it beside
		// the note, as it would anyway for a body that has been replaced.
		expect(save.mock.calls.map(([, context]) => context)).toEqual([
			undefined,
			undefined,
			{ displaced: true },
		]);
		expect(result.current.failing).toBe(true);
	});

	it('answers settle with which notes still have text the store would not take', async () => {
		const save = vi.fn<(value: string) => Promise<void>>((value) =>
			value.startsWith('bad') ? Promise.reject(new Error('no')) : Promise.resolve()
		);
		const { result, rerender } = renderHook(
			({ key }: { key: string }) => useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'a' } }
		);
		const settle = () => act(() => result.current.settle());

		act(() => {
			result.current.change('fine');
		});
		expect(await settle()).toEqual([]);

		act(() => {
			result.current.change('bad 1');
		});
		expect(await settle()).toEqual(['a']);
		// A new sitting: the editor rebuilt from the stored body, as a mode switch
		// does. What is typed next was not typed over `bad 1`, so it does not
		// stand for it and both stay held — two edits, and still one note to
		// tell the user of. Counted by edit, this says 2.
		act(() => {
			result.current.rebased();
		});
		act(() => {
			result.current.change('bad 2');
		});
		expect(await settle()).toEqual(['a']);

		// A second note, held by the same editor since the user moved on.
		rerender({ key: 'b' });
		act(() => {
			result.current.change('bad in b');
		});
		expect(await settle()).toEqual(['a', 'b']);

		// And none once a save goes through for each.
		save.mockImplementation(() => Promise.resolve());
		expect(await settle()).toEqual([]);
		expect(result.current.failing).toBe(false);
	});

	it('resolves settle only once what it started has come back', async () => {
		const { calls, save } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));
		const settled = vi.fn();

		act(() => {
			result.current.change('a');
			void result.current.settle().then(settled);
		});
		await pass(0);
		expect(calls.map((call) => call.value)).toEqual(['a']);
		expect(settled).not.toHaveBeenCalled();

		await settleCall(() => calls[0]?.reject(new Error('no')));
		await pass(0);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it('retries an edit with the save it was made for, not the one for the note now open', async () => {
		const forA = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
		const forB = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
		const { result, rerender } = renderHook(
			({ key, save }: { key: string; save: (value: string) => Promise<void> }) =>
				useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'note-a', save: forA } }
		);

		act(() => {
			result.current.change('text of a');
		});
		await pass(2000);
		rerender({ key: 'note-b', save: forB });
		act(() => {
			result.current.change('text of b');
		});
		await pass(2000);

		// Neither written into the other, and b's edit does not stand for a's.
		expect(forA.mock.calls).toEqual([['text of a'], ['text of a']]);
		expect(forB.mock.calls).toEqual([['text of b']]);
	});

	it('does not let one note that cannot be saved hold up another', async () => {
		const forA = vi.fn<(value: string) => Promise<void>>(() => Promise.reject(new Error('no')));
		const forB = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
		const { result, rerender } = renderHook(
			({ key, save }: { key: string; save: (value: string) => Promise<void> }) =>
				useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'note-a', save: forA } }
		);

		act(() => {
			result.current.change('text of a');
		});
		await pass(2000);
		rerender({ key: 'note-b', save: forB });
		act(() => {
			result.current.change('text of b');
		});
		await pass(2000);

		expect(forB.mock.calls).toEqual([['text of b']]);
		// Still true: a's words are still only here.
		expect(result.current.failing).toBe(true);
	});

	it('counts a save that throws as one that failed', async () => {
		const save = vi
			.fn<(value: string) => void>()
			.mockImplementationOnce(() => {
				throw new Error('no');
			})
			.mockImplementation(() => undefined);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
		});
		await pass(2000);
		expect(result.current.failing).toBe(true);

		await pass(AUTOSAVE_RETRY_MS);
		expect(save).toHaveBeenCalledTimes(2);
		expect(result.current.failing).toBe(false);
	});

	it('makes one last attempt when the editor goes, and none after', async () => {
		const save = vi.fn<(value: string) => Promise<void>>(() => Promise.reject(new Error('no')));
		const { result, unmount } = renderHook(() =>
			useAutosave({ key: 'a', save, delayMs: 2000 })
		);

		act(() => {
			result.current.change('a');
		});
		await pass(2000);
		unmount();
		expect(save).toHaveBeenCalledTimes(2);

		await pass(AUTOSAVE_RETRY_MS * 3);
		expect(save).toHaveBeenCalledTimes(2);
	});
});

describe('useAutosave, asked to forget a note', () => {
	it('drops what is pending and what failed, and never tries either again', async () => {
		const save = vi.fn<(value: string) => Promise<void>>(() => Promise.reject(new Error('no')));
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('failed');
		});
		await pass(2000);
		act(() => {
			result.current.change('pending');
			result.current.forget('a');
		});
		expect(result.current.failing).toBe(false);

		await pass(AUTOSAVE_RETRY_MS * 3);
		expect(save.mock.calls).toEqual([['failed']]);
	});

	it('does not retry a write that was out when it was asked, if that then fails', async () => {
		const { calls, save, values } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('last words');
			result.current.flush();
			result.current.forget('a');
		});
		await settleCall(() => calls[0]?.reject(new Error('no')));
		await pass(AUTOSAVE_RETRY_MS * 3);

		expect(values()).toEqual(['last words']);
		expect(result.current.failing).toBe(false);
	});

	it('answers with the newest text the store never took, and with nothing when it took it all', async () => {
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('refused');
		});
		await pass(2000);
		expect(result.current.failing).toBe(true);
		act(() => {
			result.current.change('refused, and more not yet sent');
		});
		const taken: (Unstored<string> | undefined)[] = [];
		act(() => {
			taken.push(result.current.forget('a'));
		});

		act(() => {
			result.current.change('stored');
			result.current.flush();
		});
		await act(async () => {
			await result.current.settle();
		});
		act(() => {
			taken.push(result.current.forget('a'));
		});

		expect(taken).toEqual([
			{ value: 'refused, and more not yet sent', displaced: false },
			undefined,
		]);
	});

	it('says so when what it lets go is not the newest: a later edit was stored that it is not under', async () => {
		const save = vi.fn<(value: string, context?: SaveContext) => Promise<void>>((value) =>
			value === 'held' ? Promise.reject(new Error('no')) : Promise.resolve()
		);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('held');
		});
		await pass(2000);
		// The editor is rebuilt from the stored body, and the user carries on.
		act(() => {
			result.current.rebased();
			result.current.change('later, and stored');
		});
		await act(async () => {
			await result.current.settle();
		});

		const taken: (Unstored<string> | undefined)[] = [];
		act(() => {
			taken.push(result.current.forget('a'));
		});
		// As the body it would undo the later edit.
		expect(taken).toEqual([{ value: 'held', displaced: true }]);
	});

	it('saves what was pending when a body arrived from outside as displaced, not over it', async () => {
		const save = vi.fn<(value: string, context?: SaveContext) => Promise<void>>(() =>
			Promise.resolve()
		);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('typed before it arrived');
			result.current.overtaken();
			result.current.change('typed over what arrived');
			result.current.flush();
		});
		await pass(0);

		expect(save.mock.calls).toEqual([
			['typed before it arrived', { displaced: true }],
			['typed over what arrived'],
		]);
	});

	it('leaves another note’s held edit alone', async () => {
		const forA = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
		const forB = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
		const { result, rerender } = renderHook(
			({ key, save }: { key: string; save: (value: string) => Promise<void> }) =>
				useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'note-a', save: forA } }
		);

		act(() => {
			result.current.change('text of a');
		});
		await pass(2000);
		rerender({ key: 'note-b', save: forB });
		act(() => {
			result.current.forget('note-b');
		});
		await pass(AUTOSAVE_RETRY_MS);

		expect(forA.mock.calls).toEqual([['text of a'], ['text of a']]);
	});
});

describe('useAutosave, across sittings', () => {
	/** A store that refuses everything until it is told to stop. */
	const fickle = () => {
		const store = { refusing: true };
		const save = vi.fn<(value: string, context?: SaveContext) => Promise<void>>(() =>
			store.refusing ? Promise.reject(new Error('no')) : Promise.resolve()
		);
		return { store, save };
	};

	it('does not let text typed after the editor was rebuilt stand for an edit it never held', async () => {
		const { store, save } = fickle();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('stored + one');
		});
		await pass(2000);
		// A mode switch: the next editor is built from what the store holds,
		// which is not this.
		act(() => {
			result.current.rebased();
		});
		await pass(0);
		store.refusing = false;
		act(() => {
			result.current.change('stored + two');
		});
		await pass(2000);

		// Kept, and handed over as displaced — for the store to keep beside the
		// note — rather than dropped, or written over "stored + two".
		expect(save.mock.calls).toEqual([
			['stored + one'],
			['stored + one'],
			['stored + two'],
			['stored + one', { displaced: true }],
		]);
		expect(result.current.failing).toBe(false);
	});

	it('lets it stand for that edit within one sitting, as it always has', async () => {
		const { store, save } = fickle();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('stored + one');
		});
		await pass(2000);
		store.refusing = false;
		act(() => {
			result.current.change('stored + one + two');
		});
		await pass(2000);
		await pass(AUTOSAVE_RETRY_MS * 3);

		expect(save.mock.calls).toEqual([['stored + one'], ['stored + one + two']]);
	});

	it('starts a new sitting when it comes back to a note', async () => {
		const { store, save } = fickle();
		const { result, rerender } = renderHook(
			({ key }: { key: string }) => useAutosave({ key, save, delayMs: 2000 }),
			{ initialProps: { key: 'note-a' } }
		);

		act(() => {
			result.current.change('a + one');
		});
		await pass(2000);
		rerender({ key: 'note-b' });
		rerender({ key: 'note-a' });
		await pass(0);
		store.refusing = false;
		act(() => {
			result.current.change('a + two');
		});
		await pass(2000);

		expect(save.mock.calls.slice(-2)).toEqual([['a + two'], ['a + one', { displaced: true }]]);
		expect(result.current.failing).toBe(false);
	});
});
