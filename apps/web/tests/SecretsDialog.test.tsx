import { encodeIdentity, recoveryKeyGroups } from '@skysa/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecretsDialog, type SecretsDialogProps } from '../src/components/SecretsDialog.js';
import { generateIdentity, parseRecipient, recipientOf, sealSecret } from '../src/secrets/age.js';
import { createSecretsLock, type SecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type KeyFileRecord, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { enrol, type Unlock, unlockKeys } from '../src/store/secretKeys.js';
import { type KeyFileWrite } from '../src/sync/keyFile.js';

/**
 * Secrets for a source (docs/ARCHITECTURE.md §7, "Secrets in a note"): setting
 * them up with a new key or one the user has, enrolling a device with the
 * source's key, and, once it is, unlocking, changing how, and letting go.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	document.body.replaceChildren();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const ROUNDS = 1000;
const PIN: Unlock = { kind: 'pin', digits: '2468' };

/** A page that stays in view, so nothing locks unless a test says so. */
const visiblePage = () => ({
	visibilityState: 'visible' as DocumentVisibilityState,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
});

const setup = async ({
	record,
	written = { status: 'written' },
}: {
	/** The key file as last read; absent, nothing was read. */
	record?: Omit<KeyFileRecord, 'connectionId'>;
	written?: KeyFileWrite;
} = {}) => {
	const db = createDatabase(`secrets-dialog-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	if (record !== undefined) await db.keyFiles.put({ connectionId: 'c1', ...record });
	const lock: SecretsLock = createSecretsLock({ target: visiblePage() });
	const keyFile = {
		refresh: vi.fn(() => Promise.resolve()),
		write: vi.fn((connectionId: string, recipient: string) => {
			if (written.status === 'written') {
				void db.keyFiles.put({ connectionId, state: 'ok', recipient, version: 'v1' });
			}
			return Promise.resolve(written);
		}),
	};
	const print = vi.fn(() => Promise.resolve());
	const copy = vi.fn((_text: string) => Promise.resolve());
	const onClose = vi.fn();
	const user = userEvent.setup();
	const open = (props: Partial<SecretsDialogProps> = {}) =>
		render(
			<SecretsDialog
				database={db}
				connectionId="c1"
				sourceName="Work"
				keyFile={keyFile}
				lock={lock}
				onClose={onClose}
				rounds={ROUNDS}
				pickGroups={() => [1, 6]}
				print={print}
				copy={copy}
				{...props}
			/>
		);
	return { db, lock, keyFile, print, copy, onClose, user, open };
};

type Harness = Awaited<ReturnType<typeof setup>>;

/** Choose a PIN, and the same again. */
const choosePin = async (h: Harness, digits = '2468') => {
	await h.user.type(await screen.findByLabelText('PIN'), digits);
	await h.user.click(screen.getByRole('button', { name: 'Next' }));
	await h.user.type(await screen.findByLabelText('PIN'), digits);
	await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));
};

const typeKey = async (h: Harness, text: string) => {
	await h.user.click(await screen.findByLabelText('Recovery key'));
	await h.user.paste(text);
	await h.user.click(screen.getByRole('button', { name: 'Continue' }));
};

/** A secret in one of the source's notes, made with `identity`'s key. */
const secretIn = async (db: NotesDatabase, identity: Uint8Array) => {
	const recipient = parseRecipient(recipientOf(identity));
	if (recipient === undefined) throw new Error('not a recipient');
	const sealed = await sealSecret('the door code', recipient);
	await createNote(db, {
		connectionId: 'c1',
		title: 'Codes',
		body: `Front:\n\n\`\`\`age\n${sealed}\n\`\`\`\n`,
	});
};

describe('setting a source up', () => {
	it('makes a key, shows it once, has two groups typed back, and keeps it under the chosen unlock', async () => {
		const h = await setup({ record: { state: 'none' } });
		h.open();
		expect(h.keyFile.refresh).toHaveBeenCalledWith('c1');

		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		const groups = await screen.findAllByRole('listitem');
		const shown = groups.slice(0, 12).map((group) => group.textContent);
		expect(shown).toHaveLength(12);

		await h.user.click(screen.getByRole('button', { name: 'Copy' }));
		const [copied] = h.copy.mock.calls[0] ?? [];
		expect(copied).toMatch(/^AGE-SECRET-KEY-1/u);
		expect(await screen.findByText('Copied.')).toBeTruthy();

		await h.user.click(screen.getByRole('button', { name: 'Print' }));
		expect(h.print).toHaveBeenCalledTimes(1);

		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		// Typed in either case, with a space: the groups are what is checked.
		await h.user.type(screen.getByLabelText('Group 2'), (shown[1] ?? '').toLowerCase());
		await h.user.type(screen.getByLabelText('Group 7'), ` ${shown[6] ?? ''}`);
		await h.user.click(screen.getByRole('button', { name: 'Check' }));

		await choosePin(h);
		expect(
			await screen.findByText('Secrets are set up, and this device can unlock them.')
		).toBeTruthy();

		const recipient = h.keyFile.write.mock.calls[0]?.[1];
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipient);
		const stored = await h.db.secretKeys.get('c1');
		expect(stored).toMatchObject({ recipient, unlock: 'pin' });
		expect(h.lock.isUnlocked('c1')).toBe(true);
		const unlocked = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(
			unlocked.status === 'unlocked' &&
				encodeIdentity(unlocked.keys.identities[0] ?? new Uint8Array())
		).toBe(copied);
	});

	it('says which group was wrong, and goes back to the key', async () => {
		const h = await setup({ record: { state: 'none' } });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		await h.user.click(screen.getByRole('button', { name: 'Next' }));

		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), 'QQQQQ');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));
		expect(screen.getByRole('alert').textContent).toBe('That is not group 7.');

		await h.user.click(screen.getByRole('button', { name: 'Back' }));
		expect((await screen.findAllByRole('listitem')).map((group) => group.textContent)).toEqual(
			shown
		);
		expect(h.keyFile.write).not.toHaveBeenCalled();
	});

	it('takes a key the user has, read however it was typed', async () => {
		const h = await setup({ record: { state: 'none' } });
		const identity = generateIdentity();
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));

		await typeKey(h, 'AGE-SECRET-KEY-1 not a key');
		expect(screen.getByRole('alert').textContent).toBe(
			'That is not a recovery key. Check each group for a mistyped character.'
		);

		await h.user.clear(screen.getByLabelText('Recovery key'));
		await typeKey(h, `AGE-SECRET-KEY-1 ${recoveryKeyGroups(identity).join('-').toLowerCase()}`);
		await choosePin(h);

		await screen.findByText('Secrets are set up, and this device can unlock them.');
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipientOf(identity));
	});

	it('says how many secrets a new key would leave locked, and can add their key as well', async () => {
		const h = await setup({ record: { state: 'none' } });
		const older = generateIdentity();
		await secretIn(h.db, older);
		await secretIn(h.db, older);
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), shown[6] ?? '');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));

		expect((await screen.findByRole('alert')).textContent).toBe(
			'2 secrets in this source were made with a different key. They stay locked unless that key is added too.'
		);
		expect(screen.getByText('They are in 2 notes.')).toBeTruthy();

		await h.user.click(screen.getByRole('button', { name: 'Add it as well' }));
		await typeKey(h, encodeIdentity(older));
		await choosePin(h);
		await screen.findByText('Secrets are set up, and this device can unlock them.');

		const unlocked = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(unlocked.status === 'unlocked' && unlocked.keys.identities.length).toBe(2);
		// The new key is the source's; the older one is kept beside it.
		expect(h.keyFile.write.mock.calls[0]?.[1]).not.toBe(recipientOf(older));
	});

	it('uses the key that made them instead, where the user says so', async () => {
		const h = await setup({ record: { state: 'none' } });
		const older = generateIdentity();
		await secretIn(h.db, older);
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		expect((await screen.findByRole('alert')).textContent).toContain('One secret');

		await h.user.click(screen.getByRole('button', { name: 'Use that key instead' }));
		await typeKey(h, encodeIdentity(older));
		await choosePin(h);

		await screen.findByText('Secrets are set up, and this device can unlock them.');
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipientOf(older));
	});

	it('asks for the key another device set up meanwhile, and keeps nothing', async () => {
		const h = await setup({ record: { state: 'none' }, written: { status: 'changed' } });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await choosePin(h);

		expect(
			(await screen.findByText(/Another device set up secrets for this source a moment ago/u))
				.textContent
		).toBeTruthy();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		expect(h.lock.isUnlocked('c1')).toBe(false);
	});

	it('says the storage could not be reached, and keeps nothing', async () => {
		const h = await setup({ record: { state: 'none' }, written: { status: 'unavailable' } });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await choosePin(h);

		expect(
			await screen.findByText(
				'This source cannot be reached right now. Try again once it syncs.'
			)
		).toBeTruthy();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
	});
});

describe('a source already set up', () => {
	it('enrolls this device with the source’s key, and no other, writing nothing', async () => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		h.open();
		expect(
			await screen.findByText(
				'This source has secrets. To open them on this device, type its recovery key.'
			)
		).toBeTruthy();

		await typeKey(h, encodeIdentity(generateIdentity()));
		expect(screen.getByRole('alert').textContent).toBe(
			'That is a recovery key, but not this source’s.'
		);
		await h.user.clear(screen.getByLabelText('Recovery key'));
		await typeKey(h, encodeIdentity(identity));
		await choosePin(h);

		await screen.findByText('This device can unlock secrets now.');
		expect(h.keyFile.write).not.toHaveBeenCalled();
		expect((await h.db.secretKeys.get('c1'))?.recipient).toBe(recipientOf(identity));
	});

	it('asks for the new key where it was replaced on another device', async () => {
		const old = generateIdentity();
		const h = await setup({
			record: { state: 'ok', recipient: recipientOf(generateIdentity()) },
		});
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: recipientOf(old),
			identities: [old],
			unlock: PIN,
			rounds: ROUNDS,
		});
		h.open();
		expect(
			await screen.findByText(
				'This source’s key was replaced on another device. Type the new recovery key to open its secrets here.'
			)
		).toBeTruthy();
	});

	it('says what it cannot use', async () => {
		const newer = await setup({ record: { state: 'newer' } });
		newer.open();
		expect(await screen.findByText(/set up by a newer version of the app/u)).toBeTruthy();
		cleanup();

		const invalid = await setup({ record: { state: 'invalid' } });
		invalid.open();
		expect(await screen.findByText(/that this app did not write/u)).toBeTruthy();
		cleanup();

		const unread = await setup();
		unread.open();
		expect(
			await screen.findByText(
				'This source cannot be reached right now. Try again once it syncs.'
			)
		).toBeTruthy();
	});
});

describe('an enrolled device', () => {
	const enrolled = async () => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: recipientOf(identity),
			identities: [identity],
			unlock: PIN,
			rounds: ROUNDS,
		});
		return { ...h, identity };
	};

	it('unlocks, says wrong tries, and locks again', async () => {
		const h = await enrolled();
		h.open();
		expect(await screen.findByText('This device unlocks secrets with a PIN.')).toBeTruthy();
		expect(screen.getByText('Locked now.')).toBeTruthy();

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));
		await h.user.type(await screen.findByLabelText('PIN'), '1357{Enter}');
		expect(await screen.findByText('That is not right.')).toBeTruthy();
		expect(h.lock.isUnlocked('c1')).toBe(false);

		await h.user.type(screen.getByLabelText('PIN'), '2468{Enter}');
		expect(await screen.findByText(/^Unlocked now\./u)).toBeTruthy();
		expect(h.lock.isUnlocked('c1')).toBe(true);

		await h.user.click(screen.getByRole('button', { name: 'Lock now' }));
		expect(await screen.findByText('Locked now.')).toBeTruthy();
		expect(h.lock.isUnlocked('c1')).toBe(false);
	});

	it('changes how it unlocks, unlocking first where it is locked', async () => {
		const h = await enrolled();
		h.open();
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');

		await h.user.click(await screen.findByRole('radio', { name: 'Password' }));
		await h.user.type(screen.getByLabelText('Password'), 'correct horse{Enter}');
		await h.user.type(await screen.findByLabelText('Password'), 'correct horse{Enter}');

		expect(
			await screen.findByText('This device unlocks secrets its new way now.')
		).toBeTruthy();
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('password');
		const opened = await unlockKeys(
			h.db,
			'c1',
			{ kind: 'password', text: 'correct horse' },
			Date.now()
		);
		expect(opened.status === 'unlocked' && opened.keys.identities[0]).toEqual(h.identity);

		// Held as changed, so changing again needs no unlock, and works.
		cleanup();
		h.open();
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await choosePin(h, '1357');
		expect(
			await screen.findByText('This device unlocks secrets its new way now.')
		).toBeTruthy();
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('pin');
	});

	it('lets go of its key once asked', async () => {
		const h = await enrolled();
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Remove from this device' }));
		expect(screen.getByText('Remove the key from this device?')).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(async () => {
			expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		});
		expect(
			await screen.findByText(
				'This source has secrets. To open them on this device, type its recovery key.'
			)
		).toBeTruthy();
	});

	it('closes on Escape', async () => {
		const h = await enrolled();
		h.open();
		await screen.findByText('This device unlocks secrets with a PIN.');
		await h.user.keyboard('{Escape}');
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});
});
