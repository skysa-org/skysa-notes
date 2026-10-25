import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdatePrompt } from '../src/components/UpdatePrompt.js';

/**
 * The prompt a new build waiting to take over puts up. Reload stops the app's
 * requests before it asks (`sync/beforeUpdate.ts`): asked while a sync was
 * going, the new build waited minutes, and the button looked dead.
 */

const registered = vi.hoisted(() => ({
	setNeedRefresh: vi.fn<(value: boolean) => void>(),
	updateServiceWorker: vi.fn<(reload?: boolean) => Promise<void>>(),
}));

vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: () => ({
		needRefresh: [true, registered.setNeedRefresh],
		offlineReady: [false, () => undefined],
		updateServiceWorker: registered.updateServiceWorker,
	}),
}));

beforeEach(() => {
	registered.setNeedRefresh.mockReset();
	registered.updateServiceWorker.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('UpdatePrompt', () => {
	it('makes way before it asks the new build to take over, and says it is updating', async () => {
		const made = Promise.withResolvers<undefined>();
		const beforeUpdate = vi.fn(() => made.promise);
		render(<UpdatePrompt beforeUpdate={beforeUpdate} />);

		fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

		expect(beforeUpdate).toHaveBeenCalledTimes(1);
		expect(screen.getByRole('status').textContent).toBe('Updating…');
		// Nothing to press twice, and no putting it off once asked.
		expect(screen.queryByRole('button')).toBeNull();
		expect(registered.updateServiceWorker).not.toHaveBeenCalled();

		await act(async () => {
			made.resolve(undefined);
			await made.promise;
		});

		expect(registered.updateServiceWorker).toHaveBeenCalledExactlyOnceWith(true);
	});

	it('says what else will do it once the page has gone a while without reloading', async () => {
		render(<UpdatePrompt beforeUpdate={() => Promise.resolve()} slowAfter={20} />);

		fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

		expect(
			await screen.findByText(
				'Still updating. If the app has not reloaded in a few minutes, close all of its windows and open it again.'
			)
		).toBeTruthy();
	});

	it('puts itself away on Later, and makes way for nothing', () => {
		const beforeUpdate = vi.fn(() => Promise.resolve());
		render(<UpdatePrompt beforeUpdate={beforeUpdate} />);

		fireEvent.click(screen.getByRole('button', { name: 'Later' }));

		expect(registered.setNeedRefresh).toHaveBeenCalledExactlyOnceWith(false);
		expect(beforeUpdate).not.toHaveBeenCalled();
		expect(registered.updateServiceWorker).not.toHaveBeenCalled();
	});
});
