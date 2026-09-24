import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '../src/components/Toast.js';

/**
 * A toast with somewhere to go about it: the connect gate's action, beside a
 * refusal (issue #131). The link is the operator's, so how it opens matters as
 * much as that it is there.
 */

afterEach(() => {
	cleanup();
});

describe('Toast', () => {
	it('is the message and a way to dismiss it, and no link, when there is nowhere to go', () => {
		render(<Toast message="Storage connected." tone="success" onDismiss={() => undefined} />);

		expect(screen.getByRole('status').textContent).toContain('Storage connected.');
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('links out in a new tab that cannot reach back, where there is somewhere to go', () => {
		const onDismiss = vi.fn();
		render(
			<Toast
				message="This account's access to sync on this server has lapsed, so storage was not connected."
				tone="error"
				action={{ label: 'See plans', url: 'https://example.com/plans' }}
				onDismiss={onDismiss}
			/>
		);

		const link = screen.getByRole('link', { name: 'See plans' });
		expect(link.getAttribute('href')).toBe('https://example.com/plans');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		// Pressing it is not pressing somewhere else: the toast stays to come
		// back to.
		fireEvent.pointerDown(link);
		expect(onDismiss).not.toHaveBeenCalled();
	});
});
