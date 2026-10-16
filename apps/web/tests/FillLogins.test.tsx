import '../src/jitless.js';

import { pageSite, VAULT_FOLDER, vaultBody, type VaultFields, vaultPayload } from '@skysa/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelState, FillChannel } from '../src/fill/channel.js';
import { PRESS_GUARD_MS } from '../src/fill/FillLogins.js';
import { FillPage } from '../src/fill/FillPage.js';
import type { Login } from '../src/fill/matches.js';
import { BOOKMARKLET_REVISION, FILL_MESSAGE, FILL_VERSION } from '../src/fill/protocol.js';
import { generateIdentity, parseRecipient, recipientOf, sealSecret } from '../src/secrets/age.js';
import { createSecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createNote, rewriteNoteBody } from '../src/store/notes.js';
import { enrol, type Unlock } from '../src/store/secretKeys.js';
import { setPasswordsShown } from '../src/store/vault.js';

/**
 * The fill window's logins (docs/ARCHITECTURE.md §7, "Filling in on a
 * site"): the unlock, asked only once the page has said who it is; the
 * passwords whose encrypted Site fills in on the page, and no others; and the
 * login filled in, or copied, from the item as it is when chosen.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	document.body.replaceChildren();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const PIN: Unlock = { kind: 'pin', digits: '2468' };

const FIELDS: VaultFields = { username: 'ada', password: 's3cret', notes: '' };

interface Item {
	readonly label: string;
	readonly fields?: VaultFields;
	/** What the item keeps beside its fields: its `urls`, for one. */
	readonly kept?: Readonly<Record<string, unknown>>;
	/** Made with a key other than the source's. */
	readonly another?: boolean;
}

interface SourceSetup {
	readonly connectionId: string;
	readonly shown?: boolean;
	readonly enrolled?: boolean;
	readonly items?: readonly Item[];
}

const helloAt = (origin: string, fields = { username: true, password: true }): ChannelState => {
	const site = pageSite(origin);
	if (site === undefined) throw new Error(origin);
	return {
		state: 'hello',
		origin,
		site,
		hello: {
			type: FILL_MESSAGE,
			v: FILL_VERSION,
			b: BOOKMARKLET_REVISION,
			step: 'hello',
			username: '',
			password: '',
			newPassword: '',
			fields: { ...fields, newPassword: false },
		},
		outdated: false,
	};
};

const setup = async ({
	sources = [{ connectionId: 'c1', items: [] }],
	at = helloAt('https://github.com'),
	before = () => Promise.resolve(),
}: {
	sources?: readonly SourceSetup[];
	at?: ChannelState;
	/** What to do to the store before the window opens. */
	before?: (db: NotesDatabase) => Promise<void>;
} = {}) => {
	const db = createDatabase(`fill-logins-${crypto.randomUUID()}`);
	opened.push(db);
	const identity = generateIdentity();
	const to = parseRecipient(recipientOf(identity));
	const elsewhere = parseRecipient(recipientOf(generateIdentity()));
	if (to === undefined || elsewhere === undefined) throw new Error('no recipient');
	const sealed = (item: Item) =>
		vaultBody(
			sealSecret(
				vaultPayload(item.fields ?? FIELDS, item.kept),
				item.another ? elsewhere : to
			)
		);
	await sources.reduce(async (before, source, place) => {
		await before;
		const { connectionId } = source;
		await db.syncState.put({
			connectionId,
			clientId: 'install',
			rootId: 'root',
			provider: 'dropbox',
			boundAt: place,
		});
		if (source.shown ?? true) await setPasswordsShown(db, connectionId, true);
		if (source.enrolled ?? true) {
			await enrol(db, {
				connectionId,
				recipient: recipientOf(identity),
				identities: [identity],
				unlock: PIN,
				rounds: 1000,
			});
		}
		await (source.items ?? []).reduce(async (made, item) => {
			await made;
			await createNote(db, {
				connectionId,
				folderPath: VAULT_FOLDER,
				title: item.label,
				body: sealed(item),
			});
		}, Promise.resolve());
	}, Promise.resolve());
	await before(db);

	const lock = createSecretsLock({
		target: {
			visibilityState: 'visible',
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		},
	});
	const clock = { current: 1_000_000 };
	const filled = vi.fn((_login: Login) => true);
	const listeners = new Set<() => void>();
	const state = { current: at };
	const channel: FillChannel = {
		current: () => state.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		fill: filled,
	};
	const move = (next: ChannelState) => {
		act(() => {
			state.current = next;
			listeners.forEach((listener) => {
				listener();
			});
		});
	};
	const close = vi.fn();
	const copy = vi.fn((_text: string) => Promise.resolve());
	const user = userEvent.setup();
	render(
		<FillPage
			channel={channel}
			db={db}
			lock={lock}
			copy={copy}
			close={close}
			now={() => clock.current}
		/>
	);
	/** Unlocked with the PIN, in the dialog asked. */
	const unlock = async () => {
		await user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
	};
	/** Time enough gone by that a press is taken. */
	const later = () => {
		clock.current += PRESS_GUARD_MS;
	};
	/** The rows listed, by their label. */
	const rows = async () =>
		(await screen.findAllByRole('listitem')).map(
			(row) => row.querySelector('.fill-login-label')?.textContent
		);
	return { db, lock, filled, close, copy, user, move, unlock, later, rows, identity, sealed };
};

const github = (more: Partial<Item> = {}): Item => ({
	label: 'GitHub',
	kept: { urls: ['https://github.com'] },
	...more,
});

describe('the fill window’s logins', () => {
	it('asks for the unlock only once the page has said who it is', async () => {
		const h = await setup({
			sources: [{ connectionId: 'c1', items: [github()] }],
			at: { state: 'waiting', slow: false },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByLabelText('PIN')).toBeNull();

		h.move(helloAt('https://github.com'));
		await h.unlock();

		expect(await h.rows()).toEqual(['GitHub']);
	});

	it('lists only the passwords whose Site fills in on the page, and never by label', async () => {
		const h = await setup({
			at: helloAt('https://login.example.com'),
			sources: [
				{
					connectionId: 'c1',
					items: [
						{ label: 'Example', kept: { urls: ['example.com'] } },
						{ label: 'Login', kept: { urls: ['https://login.example.com'] } },
						// Named for the page, with no Site: a label never fills.
						{ label: 'login.example.com' },
						{
							label: 'Look-alike',
							kept: { urls: ['https://login.example.com.evil.example'] },
						},
						{ label: 'Child only', kept: { urls: ['https://a.login.example.com'] } },
						{ label: 'Over http', kept: { urls: ['http://login.example.com'] } },
						{ label: 'Other', kept: { urls: ['https://github.com'] } },
					],
				},
			],
		});
		await h.unlock();

		expect(await h.rows()).toEqual(['Example', 'Login', 'Over http']);
		// Saved for a site above the page's, it says which.
		const example = screen.getAllByRole('listitem')[0];
		expect(example && within(example).getByText('For example.com')).toBeDefined();
	});

	it('never fills one saved over https on a page over http', async () => {
		const h = await setup({
			at: helloAt('http://github.com'),
			sources: [{ connectionId: 'c1', items: [github()] }],
		});
		await h.unlock();

		expect(await screen.findByText('No passwords for github.com.')).toBeDefined();
		expect(screen.queryByRole('listitem')).toBeNull();
	});

	it('fills in the login chosen, read from its item, and closes', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		await h.unlock();
		await h.rows();

		h.later();
		await h.user.click(screen.getByRole('button', { name: 'Fill in' }));

		await waitFor(() => {
			expect(h.filled).toHaveBeenCalledWith({ username: 'ada', password: 's3cret' });
		});
		expect(h.close).toHaveBeenCalledTimes(1);
	});

	it('lets be a press as the logins are shown, or as the window is focused', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		await h.unlock();
		await h.rows();
		const button = screen.getByRole('button', { name: 'Fill in' });

		await h.user.click(button);
		window.dispatchEvent(new Event('focus'));
		h.later();
		h.later();
		window.dispatchEvent(new Event('focus'));
		await h.user.click(button);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.filled).not.toHaveBeenCalled();

		h.later();
		await h.user.click(button);
		await waitFor(() => {
			expect(h.filled).toHaveBeenCalledTimes(1);
		});
	});

	it('offers to copy where the page had no fields to fill', async () => {
		const h = await setup({
			at: helloAt('https://github.com', { username: false, password: false }),
			sources: [{ connectionId: 'c1', items: [github()] }],
		});
		await h.unlock();
		await h.rows();
		expect(screen.queryByRole('button', { name: 'Fill in' })).toBeNull();

		h.later();
		await h.user.click(screen.getByRole('button', { name: 'Copy password' }));

		await waitFor(() => {
			expect(h.copy).toHaveBeenCalledWith('s3cret');
		});
		expect(await screen.findByText('Copied.')).toBeDefined();
		expect(h.filled).not.toHaveBeenCalled();
	});

	it('fills in nothing from an item changed meanwhile so it no longer fills in here', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		await h.unlock();
		await h.rows();
		const [note] = await h.db.notes.toArray();
		if (note === undefined) throw new Error('no item');
		await rewriteNoteBody(h.db, [note.connectionId, note.id], () =>
			h.sealed(github({ kept: { urls: ['https://github.com.evil.example'] } }))
		);

		h.later();
		await h.user.click(screen.getByRole('button', { name: 'Fill in' }));

		expect(await screen.findByText(/^That password has changed/u)).toBeDefined();
		expect(h.filled).not.toHaveBeenCalled();
		expect(h.close).not.toHaveBeenCalled();
	});

	it('says where the page has gone on, and offers to copy instead', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		h.filled.mockReturnValue(false);
		await h.unlock();
		await h.rows();

		h.later();
		await h.user.click(screen.getByRole('button', { name: 'Fill in' }));

		expect(await screen.findByText(/^The page has gone on to somewhere else/u)).toBeDefined();
		expect(screen.getByRole('button', { name: 'Copy password' })).toBeDefined();
		expect(h.close).not.toHaveBeenCalled();
	});

	it('closes as the lock locks', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		await h.unlock();
		await h.rows();
		expect(h.close).not.toHaveBeenCalled();

		act(() => {
			h.lock.lock();
		});

		expect(h.close).toHaveBeenCalled();
	});

	it('says a vault stayed locked where its unlock was closed, and asks again', async () => {
		const h = await setup({ sources: [{ connectionId: 'c1', items: [github()] }] });
		await screen.findByLabelText('PIN');

		await h.user.click(screen.getByRole('button', { name: 'Close' }));

		expect(await screen.findByText('Dropbox’s vault stayed locked.')).toBeDefined();
		expect(screen.queryByText(/^No passwords for/u)).toBeNull();

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));
		await h.unlock();
		expect(await h.rows()).toEqual(['GitHub']);
	});

	it('never asks for the recovery key, and says the app is where to use it', async () => {
		const h = await setup({
			sources: [{ connectionId: 'c1', items: [github()] }],
			// A device lock whose passkey is gone: only the recovery key is left.
			before: async (db) => {
				const record = await db.secretKeys.get('c1');
				if (record === undefined) throw new Error('not enrolled');
				await db.secretKeys.put({ ...record, unlock: 'device' });
			},
		});

		await h.user.click(await screen.findByRole('button', { name: 'Use the recovery key' }));

		expect(await screen.findByText(/^This device needs Dropbox’s recovery key/u)).toBeDefined();
		expect(screen.getByRole('button', { name: 'Open Passwords' })).toBeDefined();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('looks in each source in turn, naming each, and says which a login is in', async () => {
		const h = await setup({
			sources: [
				{ connectionId: 'c1', items: [github({ label: 'Work' })] },
				{ connectionId: 'c2', items: [github({ label: 'Home' })] },
			],
		});

		expect(
			await screen.findByRole('heading', { name: 'Unlock Dropbox’s vault' })
		).toBeDefined();
		await h.unlock();
		expect(
			await screen.findByRole('heading', { name: 'Unlock Dropbox 2’s vault' })
		).toBeDefined();
		await h.unlock();

		await waitFor(() => {
			expect(screen.getAllByRole('listitem')).toHaveLength(2);
		});
		expect(screen.getByText('In Dropbox')).toBeDefined();
		expect(screen.getByText('In Dropbox 2')).toBeDefined();
	});

	it('counts the passwords it could not open, and those it cannot read', async () => {
		const h = await setup({
			sources: [
				{
					connectionId: 'c1',
					items: [
						github(),
						{ label: 'Another key', another: true },
						{ label: 'Later', kept: { urls: 'github.com' } },
					],
				},
			],
		});
		await h.unlock();

		expect(await h.rows()).toEqual(['GitHub']);
		expect(
			await screen.findByText(
				'2 passwords could not be opened here, so they were not looked at.'
			)
		).toBeDefined();
	});

	it('says where no source shows its passwords in this browser, and asks nothing', async () => {
		await setup({ sources: [{ connectionId: 'c1', shown: false, items: [github()] }] });

		expect(
			await screen.findByText(/^Passwords are not turned on in this browser/u)
		).toBeDefined();
		expect(screen.getByText(/Home Screen or the Dock/u)).toBeDefined();
		expect(screen.queryByLabelText('PIN')).toBeNull();
	});

	it('says where this device cannot open a vault yet', async () => {
		await setup({ sources: [{ connectionId: 'c1', enrolled: false, items: [github()] }] });

		expect(
			await screen.findByText(/^One source shows its passwords in this browser, but/u)
		).toBeDefined();
		expect(screen.queryByText(/^No passwords for/u)).toBeNull();
	});

	it('asks no unlock of a source with no passwords in it', async () => {
		await setup({ sources: [{ connectionId: 'c1', items: [] }] });

		expect(await screen.findByText('No passwords for github.com.')).toBeDefined();
		expect(screen.queryByLabelText('PIN')).toBeNull();
	});
});
