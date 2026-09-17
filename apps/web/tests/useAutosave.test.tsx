import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutosave } from '../src/editor/useAutosave.js';

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
