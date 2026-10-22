import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Toast } from '../src/components/Toast.js';

/**
 * A toast with somewhere to go about it: the connect gate's action, beside a
 * refusal (issue #131). The link is the operator's, so how it opens matters as
 * much as that it is there.
 */

describe('Toast', () => {
	it('is the message and a way to dismiss it, and no link, when there is nowhere to go', () => {
		render(<Toast message="Storage connected." tone="success" onDismiss={() => undefined} />);

		expect(screen.getByRole('status').textContent).toContain('Storage connected.');
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('is dismissed by an × in its corner, which is named for what it does', () => {
		const onDismiss = vi.fn();
		render(<Toast message="Imported 1 note." tone="success" onDismiss={onDismiss} />);

		const dismiss = screen.getByRole('button', { name: 'Dismiss' });
		expect(dismiss.classList.contains('toast-close')).toBe(true);
		expect(dismiss.textContent).toBe('');
		fireEvent.click(dismiss);
		expect(onDismiss).toHaveBeenCalledTimes(1);
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
		// In this window, as connecting storage is: a new one, in an installed
		// app, had no way back.
		expect(link.getAttribute('target')).toBeNull();
		expect(link.getAttribute('rel')).toBe('noreferrer');
		// Pressing it is not pressing somewhere else: the toast stays to come
		// back to.
		fireEvent.pointerDown(link);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('opens what it is about here, with a button, and goes as it does', () => {
		const onDismiss = vi.fn();
		const onChoose = vi.fn();
		render(
			<Toast
				message="This device cannot open this source’s vault yet."
				tone="warning"
				action={{ label: 'Open Vault', onChoose }}
				onDismiss={onDismiss}
			/>
		);

		expect(screen.queryByRole('link')).toBeNull();
		const open = screen.getByRole('button', { name: 'Open Vault' });
		fireEvent.pointerDown(open);
		expect(onDismiss).not.toHaveBeenCalled();
		fireEvent.click(open);
		expect(onChoose).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
