import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLASH_MS, useFlash } from '../src/components/ui/useFlash.js';

/** Something said for a moment: a "Copied" beside a password, or in the clipboard. */

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('something said for a moment', () => {
	it('is said, and is nothing again once the moment is over', () => {
		const { result } = renderHook(() => useFlash<string | undefined>(undefined));

		act(() => {
			result.current[1]('Copied.');
		});
		expect(result.current[0]).toBe('Copied.');

		act(() => {
			vi.advanceTimersByTime(FLASH_MS - 1);
		});
		expect(result.current[0]).toBe('Copied.');

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(result.current[0]).toBeUndefined();
	});

	it('said again, has the whole moment over again', () => {
		const { result } = renderHook(() => useFlash(''));
		act(() => {
			result.current[1]('Copied.');
		});
		act(() => {
			vi.advanceTimersByTime(FLASH_MS - 1);
		});

		act(() => {
			result.current[1]('Saved.');
		});
		act(() => {
			vi.advanceTimersByTime(FLASH_MS - 1);
		});

		expect(result.current[0]).toBe('Saved.');
	});

	it('hands back the same way to say something, whatever is passed as nothing', () => {
		// A caller that writes its nothing inline passes a new one each render;
		// a new `flash` each time would re-run whatever depends on it.
		const { result, rerender } = renderHook(() => useFlash({ words: '' }));
		const [, first] = result.current;

		rerender();

		expect(result.current[1]).toBe(first);
	});

	it('leaves nothing waiting once it has gone', () => {
		const { result, unmount } = renderHook(() => useFlash(''));
		act(() => {
			result.current[1]('Copied.');
		});

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});
});
