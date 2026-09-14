import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useIncomingBody } from '../src/editor/incoming.js';

/**
 * Two ways an editor loses work by taking a body it should have ignored: its own
 * save coming back after the user has typed more, and a re-render handing it the
 * same stale prop again. Both end with the user's last few seconds of typing
 * gone, so both are decided here.
 */

const guard = (body = 'start') =>
	renderHook(({ id, value }: { id: string; value: string }) => useIncomingBody(id, value), {
		initialProps: { id: 'note-1', value: body },
	});

describe('useIncomingBody', () => {
	it('adopts a body that came from somewhere else', () => {
		const { result } = guard();
		expect(result.current.shouldAdopt('written by sync')).toBe(true);
	});

	it('ignores the body the editor was opened with', () => {
		const { result } = guard('start');
		expect(result.current.shouldAdopt('start')).toBe(false);
	});

	it('ignores the same body twice, however many times it is asked', () => {
		const { result } = guard();

		expect(result.current.shouldAdopt('written by sync')).toBe(true);
		// A re-render for some unrelated reason. Nothing new has arrived, and the
		// editor may have moved a long way past this by now.
		expect(result.current.shouldAdopt('written by sync')).toBe(false);
		expect(result.current.shouldAdopt('written by sync')).toBe(false);
	});

	it('ignores a value the editor produced itself', () => {
		const { result } = guard();
		act(() => {
			result.current.emit('typed');
		});
		expect(result.current.shouldAdopt('typed')).toBe(false);
	});

	it('ignores a stale save that lands after the user has typed more', () => {
		const { result } = guard();
		act(() => {
			result.current.emit('ab');
			result.current.emit('abc');
			result.current.emit('abcd');
		});

		// The save in flight was of 'ab'; the editor is three keystrokes past it.
		expect(result.current.shouldAdopt('ab')).toBe(false);
		expect(result.current.shouldAdopt('abc')).toBe(false);
		expect(result.current.shouldAdopt('abcd')).toBe(false);
	});

	it('forgets values older than the one that came back', () => {
		const { result } = guard();
		act(() => {
			result.current.emit('a');
			result.current.emit('ab');
		});

		expect(result.current.shouldAdopt('ab')).toBe(false);
		// 'a' was superseded by the save of 'ab': if it turns up now, something
		// else wrote it.
		expect(result.current.shouldAdopt('a')).toBe(true);
	});

	it('starts again when another note is opened', () => {
		const { result, rerender } = guard();
		act(() => {
			result.current.emit('note one body');
		});

		rerender({ id: 'note-2', value: 'note two body' });

		expect(result.current.shouldAdopt('note two body')).toBe(false);
		expect(result.current.shouldAdopt('note one body')).toBe(true);
	});

	it('keeps a stable identity, so it can be an effect dependency', () => {
		const { result, rerender } = guard();
		const first = result.current;
		rerender({ id: 'note-1', value: 'start' });
		expect(result.current).toBe(first);
	});
});
