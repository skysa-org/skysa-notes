import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_RETRY_MS, useAutosave } from '../src/editor/useAutosave.js';

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
	const calls: { value: T; resolve: () => void; reject: (error: Error) => void }[] = [];
	const save = (value: T) =>
		new Promise<void>((resolve, reject) => {
			calls.push({ value, resolve, reject });
		});
	return { calls, save };
};

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
		expect(save.mock.calls).toEqual([['only'], ['only'], ['only']]);
		expect(result.current.failing).toBe(false);

		await pass(AUTOSAVE_RETRY_MS * 3);
		expect(save).toHaveBeenCalledTimes(3);
	});

	it('tries a held edit again on the next flush, without waiting', async () => {
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('held');
		});
		await pass(2000);
		await act(async () => {
			await result.current.settle();
		});

		expect(save.mock.calls).toEqual([['held'], ['held']]);
		expect(result.current.failing).toBe(false);
	});

	it('never writes an older text after a newer one, however the first write ends', async () => {
		const { calls, save } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
			result.current.flush();
			result.current.change('ab');
			result.current.flush();
		});
		// One at a time: the newer write is not out while the older one is.
		expect(calls.map((call) => call.value)).toEqual(['a']);

		await act(async () => {
			calls[0]?.reject(new Error('no'));
			await Promise.resolve();
		});
		// The older text failed and the newer stands for it, so it is let go.
		expect(calls.map((call) => call.value)).toEqual(['a', 'ab']);

		await act(async () => {
			calls[1]?.resolve();
			await Promise.resolve();
		});
		await pass(AUTOSAVE_RETRY_MS * 3);

		expect(calls.map((call) => call.value)).toEqual(['a', 'ab']);
		expect(result.current.failing).toBe(false);
	});

	it('does not fold an edit into the write that is already out', async () => {
		const { calls, save } = manualSave<string>();
		const { result } = renderHook(() => useAutosave({ key: 'a', save, delayMs: 2000 }));

		act(() => {
			result.current.change('a');
			result.current.flush();
			result.current.change('ab');
			result.current.flush();
		});
		await act(async () => {
			calls[0]?.resolve();
			await Promise.resolve();
		});

		expect(calls.map((call) => call.value)).toEqual(['a', 'ab']);
	});

	it('still saves edits of different origins separately, oldest first', async () => {
		const save = vi
			.fn<(value: { body: string; base: number }) => Promise<void>>()
			.mockRejectedValueOnce(new Error('no'))
			.mockResolvedValue(undefined);
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
		});
		await pass(2000);
		expect(result.current.failing).toBe(true);

		// Typed into a body a pull brought in. It does not stand for the edit
		// that failed, so that one is not dropped for it, nor written after it.
		act(() => {
			result.current.change({ body: 'x', base: 2 });
		});
		await pass(2000);

		expect(save.mock.calls).toEqual([
			[{ body: 'a', base: 1 }],
			[{ body: 'a', base: 1 }],
			[{ body: 'x', base: 2 }],
		]);
		expect(result.current.failing).toBe(false);
	});

	it('holds back a later edit of another origin while the earlier one cannot be written', async () => {
		const save = vi.fn<(value: { body: string; base: number }) => Promise<void>>(() =>
			Promise.reject(new Error('no'))
		);
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
		});
		await pass(2000);
		act(() => {
			result.current.change({ body: 'x', base: 2 });
		});
		await pass(2000);

		expect(save.mock.calls.map(([value]) => value.base)).toEqual([1, 1]);
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

	it('settles once what is held has been tried, whatever came of it', async () => {
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

		await act(async () => {
			calls[0]?.reject(new Error('no'));
			await Promise.resolve();
		});
		await pass(0);
		expect(settled).toHaveBeenCalledTimes(1);
	});
});
