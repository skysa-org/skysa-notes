import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError } from '../src/api/client.js';
import { bindConnection } from '../src/store/connection.js';
import { activeConnectionId } from '../src/store/db.js';
import {
	type Answers,
	clientWith,
	dropbox,
	gear,
	holding,
	renderPanel,
	settled,
	statusLine,
	type User,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

describe('AccountPanel, listing the devices holding a connection', () => {
	const connected = async (answers: Answers) => {
		const db = freshDatabase();
		await holding(db, 'c1', 'sk1_here');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const client = clientWith({
			connection: () => Promise.resolve({ ok: true, value: dropbox }),
			...answers,
		});
		renderPanel(client, db);
		await statusLine();
		return { db, client };
	};

	const GRANTS = [
		{ id: 'g1', createdAt: 1, lastUsedAt: 1, expired: false, current: true },
		{ id: 'g2', createdAt: 2, lastUsedAt: 2, expired: false, current: false },
	];

	/** The count of the other devices, in the status line, once the server has said it. */
	const counted = (count: number): Promise<HTMLElement> =>
		screen.findByRole('button', {
			name: `${count === 1 ? '1 other device' : `${String(count)} other devices`} signed in on this account`,
		});

	/** Any count of other devices at all. */
	const ANY_COUNT = /^\d+ other devices? signed in on this account$/;

	/** The other devices, opened over everything from their count. */
	const openDevices = async (user: User): Promise<HTMLElement> => {
		await user.click(await screen.findByRole('button', { name: ANY_COUNT }));
		return screen.findByRole('dialog', { name: 'Other devices signed in on this account' });
	};

	it('names the other devices, and asks with this connection’s credential', async () => {
		const user = userEvent.setup();
		const { client } = await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
		});

		const dialog = await openDevices(user);
		const devices = within(dialog).getByRole('list', { name: 'Other devices' });

		// This one is not listed: it cannot be removed from itself, which is
		// what disconnecting is.
		expect(devices.querySelectorAll('li').length).toBe(1);
		expect(screen.queryByText(/This device/)).toBeNull();
		expect(client.asked).toContain('sk1_here');
		expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBe(1);
	});

	it('folds them behind how many there are, which is said either way', async () => {
		const user = userEvent.setup();
		const third = { id: 'g3', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		await connected({
			grants: () => Promise.resolve({ ok: true, value: [...GRANTS, third] }),
		});

		// In the status line, beside the gear: the count, and not the rows.
		const count = await counted(2);
		expect(count.getAttribute('title')).toBe('2 other devices signed in on this account');
		expect(count.parentElement).toBe((await statusLine()).parentElement);
		expect(
			count.parentElement?.contains(screen.getByRole('button', { name: 'Storage options' }))
		).toBe(true);
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

		await user.click(count);
		const dialog = await screen.findByRole('dialog', {
			name: 'Other devices signed in on this account',
		});
		expect(within(dialog).getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
	});

	it('says one other device as one', async () => {
		await connected({ grants: () => Promise.resolve({ ok: true, value: GRANTS }) });
		expect(await counted(1)).toBeTruthy();
	});

	it('opens them over everything, and Close or Escape goes back to the count', async () => {
		const user = userEvent.setup();
		await connected({ grants: () => Promise.resolve({ ok: true, value: GRANTS }) });
		const count = await counted(1);

		await user.click(count);
		const dialog = await screen.findByRole('dialog', {
			name: 'Other devices signed in on this account',
		});
		const close = within(dialog).getByRole('button', { name: 'Close' });
		expect(document.activeElement).toBe(close);
		await user.click(close);

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(count);

		await user.click(count);
		await screen.findByRole('dialog', { name: 'Other devices signed in on this account' });
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(count);
	});

	it('names each by what its browser said it was, and an older one plainly', async () => {
		const user = userEvent.setup();
		const named = { ...GRANTS[1]!, device: 'Safari on iPhone' };
		const older = { id: 'g3', createdAt: 3, lastUsedAt: 3, expired: true, current: false };
		await connected({
			grants: () => Promise.resolve({ ok: true, value: [GRANTS[0]!, named, older] }),
		});

		const rows = within(await openDevices(user))
			.getByRole('list', { name: 'Other devices' })
			.querySelectorAll('li > span');
		expect([...rows].map((row) => row.textContent)).toEqual([
			expect.stringMatching(/^Safari on iPhone, last used /),
			expect.stringMatching(/^A device, last used .* · signed out for being idle$/),
		]);
	});

	it('removes a device and asks again, so the list is what the server has', async () => {
		const user = userEvent.setup();
		const revokeGrant = vi.fn<ApiClient['revokeGrant']>(() =>
			Promise.resolve({ ok: true, value: { ok: true } })
		);
		const grants = vi
			.fn<ApiClient['grants']>()
			.mockResolvedValueOnce({ ok: true, value: GRANTS })
			.mockResolvedValue({ ok: true, value: [GRANTS[0]!] });
		await connected({ grants, revokeGrant });
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		await waitFor(() => {
			expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
		});
		expect(revokeGrant).toHaveBeenCalledWith('g2');
		// Left open, saying so, rather than taken away from under the focus; and
		// the count it was opened from has gone with the last of them.
		expect(
			within(dialog).getByText('No other device is signed in on this account.')
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();

		await user.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		// With the count gone, to the gear beside where it was.
		expect(document.activeElement).toBe(await gear());
	});

	it('says so when a device will not go, and leaves the list alone', async () => {
		const user = userEvent.setup();
		await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant: () => Promise.resolve({ ok: false, refusal: 'not_found' }),
		});
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		// Said in the dialog, where it was asked.
		expect((await within(dialog).findByRole('alert')).textContent).toMatch(
			/would not remove it/
		);
		expect(
			within(dialog).getByRole('list', { name: 'Other devices' }).querySelectorAll('li')
				.length
		).toBe(1);
	});

	it.each([
		[
			'answered with a failure',
			() => Promise.reject(new ApiError('DELETE /connection/grants/g2 failed with 500', 500)),
			/The server could not remove that device/,
		],
		[
			'could not be reached',
			() => Promise.reject(new TypeError('offline')),
			/The server cannot be reached, so nothing was removed/,
		],
	] as const)('tells a server that %s from one that did not', async (_, revokeGrant, said) => {
		const user = userEvent.setup();
		await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant,
		});
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		const problem = await screen.findByText(said);
		expect(problem.textContent).not.toMatch(/this device went wrong/);
	});

	it('does not blame the server when the credential could not be read', async () => {
		const user = userEvent.setup();
		const revokeGrant = vi.fn<ApiClient['revokeGrant']>(() =>
			Promise.resolve({ ok: true, value: { ok: true } })
		);
		const { db } = await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant,
		});
		const dialog = await openDevices(user);
		// The credential is read from this device before anything is asked of
		// the server, so this failure is strictly before the revoke.
		//
		// Refused for as long as the click is being answered, rather than once:
		// the panel is not the only reader — `reconcileAccount` and the token
		// source ask for the same credential — and a single rejection is taken
		// by whichever of them asks first, which is a race the test would lose
		// about a third of the time.
		const refused = vi
			.spyOn(db.credentials, 'get')
			.mockImplementation(() => Promise.reject(new Error('the store refused')) as never);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		const problem = await screen.findByText(/on this device went wrong/);
		refused.mockRestore();
		expect(problem.textContent).toMatch(/nothing was removed/);
		expect(problem.textContent).not.toMatch(/server|reach/i);
		expect(revokeGrant).not.toHaveBeenCalled();
	});

	it('asks again when the user switches source, so the list is that source’s', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_second');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await holding(db, 'c1', 'sk1_first');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const second = { id: 'g9', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		const client = clientWith({
			connection: async () => ({
				ok: true as const,
				value:
					(await activeConnectionId(db)) === 'c1'
						? dropbox
						: { ...dropbox, id: 'c2', provider: 'onedrive' as const },
			}),
			grants: async () => ({
				ok: true as const,
				value: (await activeConnectionId(db)) === 'c1' ? GRANTS : [...GRANTS, second],
			}),
		});
		renderPanel(client, db);
		expect(await counted(1)).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));

		// Left alone, the list would still be Dropbox's, under a line naming
		// OneDrive — and pressing Remove would send a grant id this connection
		// has never heard of.
		expect(await counted(2)).toBeTruthy();
		const dialog = await openDevices(user);
		expect(within(dialog).getByRole('list', { name: 'Other devices' }).children.length).toBe(2);
	});

	it('drops an answer about one source that arrives once another is showing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_second');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await holding(db, 'c1', 'sk1_first');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const second = { id: 'g9', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		type Answer = Awaited<ReturnType<ApiClient['grants']>>;
		const slow: { resolve: (answer: Answer) => void } = { resolve: () => undefined };
		const held = new Promise<Answer>((resolve) => {
			slow.resolve = resolve;
		});
		const client = clientWith({
			connection: async () => ({
				ok: true as const,
				value:
					(await activeConnectionId(db)) === 'c1'
						? dropbox
						: { ...dropbox, id: 'c2', provider: 'onedrive' as const },
			}),
			// Dropbox's answer is still out when the user moves on.
			grants: async () =>
				(await activeConnectionId(db)) === 'c1'
					? held
					: { ok: true as const, value: [...GRANTS, second] },
		});
		renderPanel(client, db);

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));
		expect(await counted(2)).toBeTruthy();

		await act(async () => {
			slow.resolve({ ok: true, value: GRANTS });
			await held;
		});

		expect(screen.getByRole('button', { name: ANY_COUNT }).getAttribute('aria-label')).toBe(
			'2 other devices signed in on this account'
		);
		const dialog = await openDevices(user);
		expect(within(dialog).getByRole('list', { name: 'Other devices' }).children.length).toBe(2);
	});

	it('says nothing where this is the only device, or the server cannot be asked', async () => {
		await connected({ grants: () => Promise.resolve({ ok: true, value: [GRANTS[0]!] }) });
		await settled();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();

		cleanup();
		await connected({ grants: () => Promise.reject(new TypeError('offline')) });
		await settled();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
	});
});
