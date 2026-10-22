import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';

import { useLatest } from '../src/hooks/useLatest.js';

describe('useLatest', () => {
	it('is one ref for the life of the component, holding the last value rendered', () => {
		const seen: { current: number }[] = [];
		const Probe = ({ value }: { value: number }) => {
			const latest = useLatest(value);
			seen.push(latest);
			return null;
		};
		const { rerender } = render(<Probe value={1} />);
		rerender(<Probe value={2} />);

		expect(seen[0]).toBe(seen.at(-1));
		expect(seen.at(-1)?.current).toBe(2);
	});

	it('is up to date for an effect declared after it', () => {
		const read: number[] = [];
		const Probe = ({ value }: { value: number }) => {
			const latest = useLatest(value);
			useEffect(() => {
				read.push(latest.current);
			});
			return null;
		};
		const { rerender } = render(<Probe value={1} />);
		act(() => {
			rerender(<Probe value={2} />);
		});

		expect(read).toEqual([1, 2]);
	});
});
