import { encodeIdentity, readRecoveryKey, recoveryKeyGroups, secretBlocksIn } from '@skysa/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecretsDialog, type SecretsDialogProps } from '../src/components/SecretsDialog.js';
import {
	generateIdentity,
	openSecret,
	opensSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';
import { type DeviceLock, type Made } from '../src/secrets/deviceLock.js';
import { type Age, loadAge } from '../src/secrets/loadAge.js';
import { createSecretsLock, type SecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type KeyFileRecord, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { enrol, enrolment, MAX_TRIES, type Unlock, unlockKeys } from '../src/store/secretKeys.js';
import { type KeyFileWrite } from '../src/sync/keyFile.js';
import { readQr } from './qrRead.js';

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

/** A key pasted into its first group: with its prefix, it fills them all. */
const typeKey = async (h: Harness, text: string) => {
	await h.user.click(await screen.findByLabelText('Group 1'));
	await h.user.paste(text);
	await h.user.click(screen.getByRole('button', { name: 'Continue' }));
};

/** A secret in one of the source's notes, made with `identity`'s key. */
const secretIn = async (db: NotesDatabase, identity: Uint8Array) => {
	const recipient = parseRecipient(recipientOf(identity));
	if (recipient === undefined) throw new Error('not a recipient');
	const sealed = sealSecret('the door code', recipient);
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
		const [copied = ''] = h.copy.mock.calls[0] ?? [];
		// In its groups, as it is shown: read back, it is the key.
		expect(copied).toBe(['AGE-SECRET-KEY-1', ...shown].join(' '));
		const key = readRecoveryKey(copied);
		expect(await screen.findByText('Copied.')).toBeTruthy();

		await h.user.click(screen.getByRole('button', { name: 'Print' }));
		expect(h.print).toHaveBeenCalledTimes(1);
		// Its QR code, on screen and on the printed page, reads as the key.
		const code = screen.getByRole('img', { name: 'Recovery key as a QR code' });
		expect(readQr(code)).toBe(['AGE-SECRET-KEY-1', ...shown].join(''));
		expect(document.querySelector('.recovery-print .recovery-qr')).not.toBeNull();

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
		).toBe(key && encodeIdentity(key));
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

	it('takes no key it cannot check where the folder names none after another device wrote first', async () => {
		const h = await setup({ record: { state: 'none' }, written: { status: 'changed' } });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await choosePin(h);

		expect((await screen.findByRole('alert')).textContent).toMatch(/^Another device set up/u);
		// Where it starts again: the folder said nothing that a key could be checked against.
		expect(screen.getByRole('button', { name: 'Make a recovery key' })).toBeTruthy();
		expect(screen.queryByLabelText('Recovery key')).toBeNull();
	});

	it('says what the folder holds where another device wrote something it cannot use', async () => {
		const h = await setup({ record: { state: 'none' }, written: { status: 'changed' } });
		h.keyFile.write.mockImplementation(async (connectionId: string) => {
			await h.db.keyFiles.put({ connectionId, state: 'newer' });
			return { status: 'changed' };
		});
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await choosePin(h);

		expect(await screen.findByText(/set up by a newer version of the app/u)).toBeTruthy();
		expect(screen.queryByLabelText('Recovery key')).toBeNull();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
	});

	it('says a step that failed, and finishes on a second try with the key file it wrote on the first', async () => {
		const h = await setup({ record: { state: 'none' } });
		const identity = generateIdentity();
		// Written once; after that, the folder has it, and a create-only write is refused.
		h.keyFile.write.mockImplementation(async (connectionId: string, recipient: string) => {
			const was = await h.db.keyFiles.get(connectionId);
			if (was?.state === 'ok') return { status: 'changed' };
			await h.db.keyFiles.put({ connectionId, state: 'ok', recipient, version: 'v1' });
			return { status: 'written' };
		});
		const put = vi.spyOn(h.db.secretKeys, 'put').mockRejectedValueOnce(new Error('quota'));
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(identity));
		await choosePin(h);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'That did not work. Try again.'
		);
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();

		// What was chosen is still there, to set again.
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));
		await screen.findByText('Secrets are set up, and this device can unlock them.');
		expect(put).toHaveBeenCalledTimes(2);
		expect((await h.db.secretKeys.get('c1'))?.recipient).toBe(recipientOf(identity));
	});

	it('says it failed where the age code does not load, and can be tried again', async () => {
		const h = await setup({ record: { state: 'none' } });
		const age = vi
			.fn<() => Promise<Age>>()
			.mockRejectedValueOnce(new Error('stale chunk'))
			.mockImplementation(loadAge);
		h.open({ age });
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));

		expect((await screen.findByRole('alert')).textContent).toBe(
			'That did not work. Try again.'
		);
		await h.user.click(screen.getByRole('button', { name: 'Make a recovery key' }));
		expect(await screen.findAllByRole('listitem')).toHaveLength(12);
	});

	it('says it is looking while it tries the key, and checks only once', async () => {
		const h = await setup({ record: { state: 'none' } });
		const scanned = { release: () => undefined as void };
		const age = async (): Promise<Age> => {
			const real = await loadAge();
			return {
				...real,
				scanSecrets: async (...args) => {
					await new Promise<void>((resolve) => {
						scanned.release = resolve;
					});
					return real.scanSecrets(...args);
				},
			};
		};
		h.open({ age });
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), shown[6] ?? '');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));

		expect(await screen.findByText('Looking for secrets in this source’s notes…')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Check' }).hasAttribute('disabled')).toBe(true);
		scanned.release();
		expect(await screen.findByText('How should this device unlock secrets?')).toBeTruthy();
	});

	it('fills the keys it made with zeros once they are kept, and as it closes', async () => {
		const made: Uint8Array[] = [];
		const age = async (): Promise<Age> => {
			const real = await loadAge();
			return {
				...real,
				generateIdentity: () => {
					const identity = real.generateIdentity();
					made.push(identity);
					return identity;
				},
			};
		};
		const h = await setup({ record: { state: 'none' } });
		h.open({ age });
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		const recipient = recipientOf(made[0] ?? new Uint8Array());
		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), shown[6] ?? '');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));
		await choosePin(h);
		await screen.findByText('Secrets are set up, and this device can unlock them.');

		expect(made[0]?.every((byte) => byte === 0)).toBe(true);
		// What was kept is the key, not the zeros.
		const unlocked = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(
			unlocked.status === 'unlocked' && recipientOf(unlocked.keys.identities[0] ?? made[0]!)
		).toBe(recipient);

		cleanup();
		const again = await setup({ record: { state: 'none' } });
		const view = again.open({ age });
		await again.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		await screen.findAllByRole('listitem');
		expect(made[1]?.some((byte) => byte !== 0)).toBe(true);
		view.unmount();
		expect(made[1]?.every((byte) => byte === 0)).toBe(true);
	});

	it('keeps the focus in the dialog as its steps change, so Escape still closes it', async () => {
		const h = await setup({ record: { state: 'none' } });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Make a recovery key' }));
		await screen.findAllByRole('listitem');

		await waitFor(() => {
			expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
		});
		// And wherever the focus is: a click on the page behind leaves it there.
		(document.activeElement as HTMLElement).blur();
		await h.user.keyboard('{Escape}');
		expect(h.onClose).toHaveBeenCalledTimes(1);
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

/** The one row of buttons the dialog has, by what each says. */
const buttonRow = (): (string | null)[] => {
	const rows = document.querySelectorAll('.dialog-actions');
	expect(rows).toHaveLength(1);
	return [...(rows[0]?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
};

describe('each step’s buttons', () => {
	it('start with the dialog’s own way out and end in the answer, which has the focus', async () => {
		const h = await setup({ record: { state: 'none' } });
		h.open();
		const make = await screen.findByRole('button', { name: 'Make a recovery key' });
		expect(buttonRow()).toEqual(['Close', 'Use a key I have', 'Make a recovery key']);
		expect(document.activeElement).toBe(make);

		await h.user.click(screen.getByRole('button', { name: 'Use a key I have' }));
		// Where there is something to type, it is where the focus goes.
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByLabelText('Group 1'));
		});
		expect(buttonRow()).toEqual(['Cancel', 'Continue']);
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

	/** The device enrolled with an old key and another, and the source's key since replaced. */
	const replacedOn = async ({ heldAlready = false } = {}) => {
		const source = generateIdentity();
		const old = generateIdentity();
		// Added as well, before it became the source's: kept once.
		const extra = heldAlready ? source : generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(source) } });
		const keys = await enrol(h.db, {
			connectionId: 'c1',
			recipient: recipientOf(old),
			identities: [old, extra],
			unlock: PIN,
			rounds: ROUNDS,
		});
		return { ...h, source, old, extra, keys };
	};

	const heldAfter = async (h: Harness): Promise<string[]> => {
		const unlocked = await unlockKeys(h.db, 'c1', PIN, Date.now());
		return unlocked.status === 'unlocked' ? unlocked.keys.identities.map(encodeIdentity) : [];
	};

	it('keeps the keys the device held beside the new one, unlocking it first', async () => {
		const h = await replacedOn();
		h.open();
		await typeKey(h, encodeIdentity(generateIdentity()));
		expect(screen.getByRole('alert').textContent).toBe(
			'That is a recovery key, but not this source’s.'
		);
		await typeKey(h, encodeIdentity(h.source));

		expect(await screen.findByText(/^Unlock this device too/u)).toBeTruthy();
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');

		expect(
			await screen.findByText(
				'This device opens secrets with the new key now, and still with the keys it had.'
			)
		).toBeTruthy();
		expect((await h.db.secretKeys.get('c1'))?.recipient).toBe(recipientOf(h.source));
		expect(await heldAfter(h)).toEqual([h.source, h.old, h.extra].map(encodeIdentity));
		expect(h.lock.isUnlocked('c1')).toBe(true);
		expect(h.keyFile.write).not.toHaveBeenCalled();
	});

	it('asks nothing more where the device is unlocked, and holds the key once', async () => {
		const h = await replacedOn({ heldAlready: true });
		const unlocked = await unlockKeys(h.db, 'c1', PIN, Date.now());
		if (unlocked.status !== 'unlocked') throw new Error('not unlocked');
		h.lock.hold(unlocked.keys);
		h.open();
		// Typed as well as held: kept once, in the source's place.
		await typeKey(h, encodeIdentity(h.source));

		await screen.findByText(
			'This device opens secrets with the new key now, and still with the keys it had.'
		);
		expect(await heldAfter(h)).toEqual([h.source, h.old].map(encodeIdentity));
	});

	it('keeps only the new key where the user says so', async () => {
		const h = await replacedOn();
		h.open();
		await typeKey(h, encodeIdentity(h.source));
		await h.user.click(await screen.findByRole('button', { name: 'Keep only the new key' }));
		await choosePin(h);

		await screen.findByText('This device can unlock secrets now.');
		expect(await heldAfter(h)).toEqual([encodeIdentity(h.source)]);
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

	it('leaves the dialog’s Close off removing, whose Cancel goes back', async () => {
		const h = await enrolled();
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Remove from this device' }));

		expect(buttonRow()).toEqual(['Cancel', 'Remove']);
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove' }));
		});
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await screen.findByRole('button', { name: 'Remove from this device' })).toBeTruthy();
		expect(buttonRow()[0]).toBe('Close');
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

	it('puts back a key file the folder lost, naming the key it holds, rather than setting up anew', async () => {
		const h = await enrolled();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		h.open();
		expect(await screen.findByText(/no longer has the file that names it/u)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Make a recovery key' })).toBeNull();

		await h.user.click(screen.getByRole('button', { name: 'Put it back' }));
		expect(await screen.findByText('The source’s folder names its key again.')).toBeTruthy();
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipientOf(h.identity));
		expect((await unlockKeys(h.db, 'c1', PIN, Date.now())).status === 'unlocked').toBe(true);
	});

	it('takes no unchecked key where the folder names none by the time the device’s copy is gone', async () => {
		const h = await enrolled();
		const record = await h.db.secretKeys.get('c1');
		if (record === undefined) throw new Error('not enrolled');
		await h.db.secretKeys.put({ ...record, tries: MAX_TRIES - 1 });
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		await h.user.type(await screen.findByLabelText('PIN'), '1357{Enter}');
		await h.user.click(await screen.findByRole('button', { name: 'Use the recovery key' }));
		expect(await screen.findByLabelText('Recovery key')).toBeTruthy();

		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });

		expect(await screen.findByRole('button', { name: 'Make a recovery key' })).toBeTruthy();
		expect(screen.queryByLabelText('Recovery key')).toBeNull();
	});

	it('closes on Escape', async () => {
		const h = await enrolled();
		h.open();
		await screen.findByText('This device unlocks secrets with a PIN.');
		await h.user.keyboard('{Escape}');
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});
});

describe('replacing the source’s key', () => {
	/** A device enrolled with the source's key, and any `added` beside it, and unlocked. */
	const ready = async (written?: KeyFileWrite, added: readonly Uint8Array[] = []) => {
		const identity = generateIdentity();
		const recipient = recipientOf(identity);
		const h = await setup({
			record: { state: 'ok', recipient },
			...(written === undefined ? {} : { written }),
		});
		const keys = await enrol(h.db, {
			connectionId: 'c1',
			recipient,
			identities: [identity, ...added],
			unlock: PIN,
			rounds: ROUNDS,
		});
		if (keys === undefined) throw new Error('not enrolled');
		h.lock.hold(keys);
		return { ...h, identity, recipient };
	};

	/** Every secret in the source's notes. */
	const secretsNow = async (db: NotesDatabase) =>
		(await db.notes.where('connectionId').equals('c1').toArray()).flatMap((note) =>
			secretBlocksIn(note.body)
		);

	/** Replace key…, Use a key I have, and `identity` typed: what replacing with it will do is said. */
	const pasted = async (h: Harness, identity: Uint8Array) => {
		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(identity));
		await screen.findByRole('button', { name: 'Replace key' });
	};

	it('makes a new key, has it typed back, and encrypts the secrets made with the old one to it', async () => {
		const h = await ready();
		const other = generateIdentity();
		await secretIn(h.db, h.identity);
		await secretIn(h.db, h.identity);
		await secretIn(h.db, other);
		const before = await h.db.notes.toArray();
		h.open();

		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		expect(
			screen.getByText(/version history, can still be opened with the old key\.$/u)
		).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Make a new key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), shown[6] ?? '');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));

		expect(await screen.findByText('2 secrets will be encrypted to the new key.')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toBe(
			'One secret in this source was made with a different key. The new key won’t open it, and it stays as it is.'
		);
		expect(h.keyFile.write).not.toHaveBeenCalled();
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText('The key was replaced, and 2 secrets were encrypted to it.')
		).toBeTruthy();
		const fresh = readRecoveryKey(`AGE-SECRET-KEY-1${shown.join('')}`) ?? new Uint8Array();
		const recipient = recipientOf(fresh);
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipient, h.recipient);
		expect(await enrolment(h.db, 'c1')).toMatchObject({ recipient, former: [h.recipient] });
		const opened = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(opened.status === 'unlocked' && opened.keys.identities).toEqual([fresh, h.identity]);
		expect(h.lock.keys('c1')?.recipient).toBe(recipient);

		const blocks = await secretsNow(h.db);
		const resealed = blocks.filter((block) => opensSecret(block, [fresh]));
		expect(resealed.map((block) => openSecret(block, [fresh]))).toEqual([
			'the door code',
			'the door code',
		]);
		expect(blocks.filter((block) => opensSecret(block, [h.identity]))).toEqual([]);
		expect(blocks.filter((block) => opensSecret(block, [other]))).toHaveLength(1);
		// Written in from outside the editors, and only where a secret changed.
		const after = await h.db.notes.toArray();
		const moved = after.filter(
			(note) => before.find((was) => was.id === note.id)?.bodyOrigin !== note.bodyOrigin
		);
		expect(moved).toHaveLength(2);
		expect(moved.every((note) => note.dirty === 1)).toBe(true);
	});

	it('uses a key the user has, but not the one the source has now', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		await h.user.click(screen.getByRole('button', { name: 'Use a key I have' }));

		await typeKey(h, encodeIdentity(h.identity));
		expect((await screen.findByRole('alert')).textContent).toBe(
			'That is this source’s key now. Use another.'
		);
		const theirs = generateIdentity();
		await typeKey(h, encodeIdentity(theirs));

		expect(
			await screen.findByText('One secret will be encrypted to the new key.')
		).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));
		expect(
			await screen.findByText('The key was replaced, and one secret was encrypted to it.')
		).toBeTruthy();
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipientOf(theirs), h.recipient);
		expect((await secretsNow(h.db)).map((block) => opensSecret(block, [theirs]))).toEqual([
			true,
		]);
	});

	it('leaves secrets made with a key added from another source as they are, and keeps it', async () => {
		const added = generateIdentity();
		const h = await ready(undefined, [added]);
		await secretIn(h.db, h.identity);
		await secretIn(h.db, added);
		const theirs = generateIdentity();
		h.open();
		await pasted(h, theirs);

		expect(screen.getByText('One secret will be encrypted to the new key.')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toMatch(
			/^One secret in this source was made with a different key\./u
		);
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));
		await screen.findByText('The key was replaced, and one secret was encrypted to it.');

		const blocks = await secretsNow(h.db);
		expect(blocks.map((block) => opensSecret(block, [theirs]))).toContain(true);
		expect(blocks.filter((block) => opensSecret(block, [added]))).toHaveLength(1);
		const opened = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(opened.status === 'unlocked' && opened.keys.identities).toEqual([
			theirs,
			h.identity,
			added,
		]);
		expect(await enrolment(h.db, 'c1')).toMatchObject({ former: [h.recipient] });
	});

	it('encrypts what a key the source had before opens, where it was replaced on this device already', async () => {
		const older = generateIdentity();
		const h = await ready(undefined, [older]);
		// Put whole: Dexie's `update` does not keep the record's ArrayBuffers.
		const record = await h.db.secretKeys.get('c1');
		if (record === undefined) throw new Error('not enrolled');
		await h.db.secretKeys.put({ ...record, former: [recipientOf(older)] });
		await secretIn(h.db, older);
		await secretIn(h.db, h.identity);
		const theirs = generateIdentity();
		h.open();
		await pasted(h, theirs);

		expect(screen.getByText('2 secrets will be encrypted to the new key.')).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));
		await screen.findByText('The key was replaced, and 2 secrets were encrypted to it.');
		expect((await secretsNow(h.db)).map((block) => opensSecret(block, [theirs]))).toEqual([
			true,
			true,
		]);
		expect(await enrolment(h.db, 'c1')).toMatchObject({
			former: [recipientOf(older), h.recipient],
		});
	});

	it('takes no key to replace it with where the folder names none by the time it is typed', async () => {
		const h = await ready();
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		await h.user.click(screen.getByRole('button', { name: 'Use a key I have' }));
		expect(await screen.findByLabelText('Recovery key')).toBeTruthy();

		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });

		expect(await screen.findByRole('button', { name: 'Put it back' })).toBeTruthy();
		expect(screen.queryByLabelText('Recovery key')).toBeNull();
	});

	it('says some are left where encrypting them fails', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		const age = async (): Promise<Age> => ({
			...(await loadAge()),
			resealSecrets: () => Promise.reject(new Error('the disk is full')),
		});
		h.open({ age });
		await pasted(h, generateIdentity());
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText(/^The key was replaced\. Some secrets are still made/u)
		).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('says where there is nothing to encrypt again', async () => {
		const h = await ready();
		h.open();
		await pasted(h, generateIdentity());

		expect(
			screen.getByText('No secrets in this source need to be encrypted again.')
		).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));
		expect(await screen.findByText('The key was replaced.')).toBeTruthy();
	});

	it('changes nothing where another device replaced the key first, and asks for that key', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		const elsewhere = recipientOf(generateIdentity());
		h.keyFile.write.mockImplementation(async () => {
			await h.db.keyFiles.put({ connectionId: 'c1', state: 'ok', recipient: elsewhere });
			return { status: 'changed' };
		});
		const before = await h.db.notes.toArray();
		h.open();
		await pasted(h, generateIdentity());
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText(
				'This source’s key was replaced on another device first, so this key was not used.'
			)
		).toBeTruthy();
		expect(
			screen.getByText(/replaced on another device\. Type the new recovery key/u)
		).toBeTruthy();
		expect(await enrolment(h.db, 'c1')).toMatchObject({ recipient: h.recipient, former: [] });
		expect(await h.db.notes.toArray()).toEqual(before);
	});

	it('goes on where the key file was written on a try that failed after it', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		const theirs = generateIdentity();
		h.keyFile.write.mockImplementation(async (connectionId: string, recipient: string) => {
			await h.db.keyFiles.put({ connectionId, state: 'ok', recipient });
			return { status: 'changed' };
		});
		h.open();
		await pasted(h, theirs);
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText('The key was replaced, and one secret was encrypted to it.')
		).toBeTruthy();
		expect(await enrolment(h.db, 'c1')).toMatchObject({ recipient: recipientOf(theirs) });
	});

	it('says where the folder could not be written, and changes nothing', async () => {
		const h = await ready({ status: 'failed' });
		await secretIn(h.db, h.identity);
		h.open();
		await pasted(h, generateIdentity());
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect((await screen.findByRole('alert')).textContent).toBe(
			'The key could not be replaced in your storage. Try again.'
		);
		expect(screen.getByRole('button', { name: 'Replace key' })).toBeTruthy();
		expect(await enrolment(h.db, 'c1')).toMatchObject({ recipient: h.recipient, former: [] });
		expect((await secretsNow(h.db)).map((block) => opensSecret(block, [h.identity]))).toEqual([
			true,
		]);
	});

	it('changes nothing where the keys were sealed again in another window', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		const theirs = generateIdentity();
		h.open();
		await pasted(h, theirs);
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: h.recipient,
			identities: [h.identity],
			unlock: PIN,
			rounds: ROUNDS,
		});
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText(
				'The key on this device changed in another window. Unlock it again, then try again.'
			)
		).toBeTruthy();
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect((await secretsNow(h.db)).map((block) => opensSecret(block, [h.identity]))).toEqual([
			true,
		]);
	});

	it('unlocks first, where the device is locked, and again where it locks before the key is replaced', async () => {
		const h = await ready();
		h.lock.lock();
		h.open();
		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await screen.findByRole('button', { name: 'Replace key' });

		act(() => {
			h.lock.lock();
		});
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
		await h.user.click(await screen.findByRole('button', { name: 'Replace key' }));

		expect(await screen.findByText('The key was replaced.')).toBeTruthy();
		expect(h.keyFile.write).toHaveBeenCalledTimes(1);
	});

	it('stops where the device locks as it encrypts, keeping the old key for what is left', async () => {
		const h = await ready();
		await secretIn(h.db, h.identity);
		const theirs = generateIdentity();
		const age = async (): Promise<Age> => {
			const real = await loadAge();
			return {
				...real,
				resealSecrets: (...args) => {
					h.lock.lock();
					return real.resealSecrets(...args);
				},
			};
		};
		h.open({ age });
		await pasted(h, theirs);
		await h.user.click(screen.getByRole('button', { name: 'Replace key' }));

		expect(
			await screen.findByText(
				'The key was replaced. Some secrets are still made with the old key, and are encrypted to the new one the next time this device is unlocked.'
			)
		).toBeTruthy();
		expect(await enrolment(h.db, 'c1')).toMatchObject({
			recipient: recipientOf(theirs),
			former: [h.recipient],
		});
		expect((await secretsNow(h.db)).map((block) => opensSecret(block, [h.identity]))).toEqual([
			true,
		]);
	});

	it('fills each copy of a key it used with zeros, and leaves the lock’s own', async () => {
		const used: Uint8Array[] = [];
		const age = async (): Promise<Age> => {
			const real = await loadAge();
			return {
				...real,
				generateIdentity: () => {
					const made = real.generateIdentity();
					used.push(made);
					return made;
				},
				scanReplacing: (db, connectionId, fresh, old) => {
					used.push(...fresh, ...old);
					return real.scanReplacing(db, connectionId, fresh, old);
				},
				resealSecrets: (db, connectionId, input) => {
					used.push(...input.fresh, ...input.old);
					return real.resealSecrets(db, connectionId, input);
				},
			};
		};
		const h = await ready();
		await secretIn(h.db, h.identity);
		h.open({ age });
		await h.user.click(await screen.findByRole('button', { name: 'Replace key…' }));
		await h.user.click(screen.getByRole('button', { name: 'Make a new key' }));
		const shown = (await screen.findAllByRole('listitem')).map((group) => group.textContent);
		await h.user.click(screen.getByRole('button', { name: 'Next' }));
		await h.user.type(screen.getByLabelText('Group 2'), shown[1] ?? '');
		await h.user.type(screen.getByLabelText('Group 7'), shown[6] ?? '');
		await h.user.click(screen.getByRole('button', { name: 'Check' }));
		await h.user.click(await screen.findByRole('button', { name: 'Replace key' }));
		await screen.findByText('The key was replaced, and one secret was encrypted to it.');

		expect(used).toHaveLength(5);
		expect(used.every((key) => key.every((byte) => byte === 0))).toBe(true);
		const held = h.lock.keys('c1')?.identities ?? [];
		expect(held).toHaveLength(2);
		expect(held.every((key) => key.some((byte) => byte !== 0))).toBe(true);
	});
});

describe('the device’s own lock', () => {
	const CREDENTIAL = new Uint8Array([1, 2, 3]).buffer;
	const DEVICE = 'This device’s lock';

	/**
	 * A device whose passkey is made as `made` says, and answers each ask with
	 * the same bytes, noting each answer it gave and whether the app was
	 * prompting as it was asked. `onAsked` runs as the passkey is made.
	 */
	const deviceWith = (
		h: Harness,
		made: Made = { state: 'made', credentialId: CREDENTIAL },
		onAsked: () => void = () => undefined
	) => {
		const given: Uint8Array[] = [];
		const prompted: boolean[] = [];
		const inPrompt = { current: false };
		const prompting = h.lock.prompting;
		vi.spyOn(h.lock, 'prompting').mockImplementation(async (work) => {
			inPrompt.current = true;
			try {
				return await prompting(work);
			} finally {
				inPrompt.current = false;
			}
		});
		const device: DeviceLock = {
			offered: () => Promise.resolve(true),
			create: vi.fn(() => {
				prompted.push(inPrompt.current);
				onAsked();
				return Promise.resolve(made);
			}),
			answer: vi.fn(() => {
				prompted.push(inPrompt.current);
				const answer = new Uint8Array(32).fill(7);
				given.push(answer);
				return Promise.resolve(answer);
			}),
			forget: vi.fn(() => Promise.resolve()),
		};
		return { device, given, prompted };
	};

	/** A device already unlocking with its own lock, through the passkey `CREDENTIAL`. */
	const enrolledWithDevice = async (answer = 7) => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: recipientOf(identity),
			identities: [identity],
			unlock: {
				kind: 'device',
				credentialId: CREDENTIAL,
				salt: new Uint8Array(32).fill(3).buffer,
				answer: new Uint8Array(32).fill(answer),
			},
		});
		return { ...h, identity };
	};

	const OTHER = new Uint8Array([4, 5, 6]).buffer;

	/** The bytes of each passkey `device` was told to let go of, in turn. */
	const forgotten = (device: DeviceLock) =>
		vi.mocked(device.forget).mock.calls.map(([id]) => [...new Uint8Array(id)]);

	const wiped = (given: readonly Uint8Array[]) =>
		given.length > 0 && given.every((answer) => answer.every((byte) => byte === 0));

	const enrolledWithPin = async () => {
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

	it('is not offered where the device has none', async () => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		h.open({ deviceLock: { ...deviceWith(h).device, offered: () => Promise.resolve(false) } });
		await typeKey(h, encodeIdentity(identity));

		expect(await screen.findByLabelText('PIN')).toBeTruthy();
		expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).not.toContain(
			DEVICE
		);
		expect(screen.queryByRole('radio', { name: DEVICE })).toBeNull();
	});

	it('enrolls the device with it, asked as a prompt of the app’s own, and unlocks with it', async () => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		const { device, given, prompted } = deviceWith(h);
		h.open({ deviceLock: device });
		await typeKey(h, encodeIdentity(identity));
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		expect(
			screen.getByText(
				'Your device asks for your fingerprint, face or screen lock to make a key for this, and to check it.'
			)
		).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		await screen.findByText('This device can unlock secrets now.');
		expect(device.create).toHaveBeenCalledWith(
			expect.any(Uint8Array),
			'Unlocks secrets on this device: Work'
		);
		// Made, then asked twice: what it answered as it was made was nothing.
		expect(prompted).toEqual([true, true, true]);
		const record = await h.db.secretKeys.get('c1');
		expect(record?.unlock).toBe('device');
		expect(new Uint8Array(record?.credentialId ?? new ArrayBuffer(0))).toEqual(
			new Uint8Array(CREDENTIAL)
		);
		expect(h.lock.isUnlocked('c1')).toBe(true);
		expect(h.keyFile.write).not.toHaveBeenCalled();
		// What the device answered is let go of once the keys are sealed under it.
		expect(wiped(given)).toBe(true);
		expect(device.forget).not.toHaveBeenCalled();

		cleanup();
		h.open({ deviceLock: device });
		expect(
			await screen.findByText('This device unlocks secrets with its own lock.')
		).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Lock now' }));
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		expect(await screen.findByText('Unlock with this device’s lock.')).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(await screen.findByText(/^Unlocked now\./u)).toBeTruthy();
		expect(h.lock.isUnlocked('c1')).toBe(true);
		expect(prompted).toEqual([true, true, true, true]);
	});

	it('sets a source up with it, writing the key file only once the device has answered', async () => {
		const h = await setup({ record: { state: 'none' } });
		const identity = generateIdentity();
		const { device } = deviceWith(h);
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(identity));
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		await screen.findByText('Secrets are set up, and this device can unlock them.');
		expect(h.keyFile.write).toHaveBeenCalledWith('c1', recipientOf(identity));
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('device');
	});

	it('lets go of the passkey made, where the key file could not be written', async () => {
		const h = await setup({ record: { state: 'none' }, written: { status: 'unavailable' } });
		const { device } = deviceWith(h);
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect(
			await screen.findByText(
				'This source cannot be reached right now. Try again once it syncs.'
			)
		).toBeTruthy();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
	});

	it('says the device’s lock did not answer, writes and keeps nothing, and can be tried again', async () => {
		const h = await setup({ record: { state: 'none' } });
		const { device } = deviceWith(h, { state: 'refused' });
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Use a key I have' }));
		await typeKey(h, encodeIdentity(generateIdentity()));
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect((await screen.findByRole('alert')).textContent).toBe(
			'Your device’s lock did not answer. Try again, or choose another way.'
		);
		expect(h.keyFile.write).not.toHaveBeenCalled();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(device.forget).not.toHaveBeenCalled();

		vi.mocked(device.create).mockResolvedValue({ state: 'made', credentialId: CREDENTIAL });
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));
		await screen.findByText('Secrets are set up, and this device can unlock them.');
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('device');
	});

	it('is not offered again where it cannot keep a key, and the device enrolls another way', async () => {
		const identity = generateIdentity();
		const h = await setup({ record: { state: 'ok', recipient: recipientOf(identity) } });
		const { device } = deviceWith(h, { state: 'unsupported', credentialId: CREDENTIAL });
		h.open({ deviceLock: device });
		await typeKey(h, encodeIdentity(identity));
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect(
			await screen.findByText(
				'This device’s lock cannot keep secrets in this browser. Choose another way.'
			)
		).toBeTruthy();
		expect(screen.queryByRole('radio', { name: DEVICE })).toBeNull();
		expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		// Made, and of no use: let go of, so no password manager lists it.
		expect(forgotten(device)).toEqual([[1, 2, 3]]);

		await choosePin(h);
		await screen.findByText('This device can unlock secrets now.');
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('pin');
	});

	it('changes to it and back, letting go of the passkey’s id', async () => {
		const h = await enrolledWithPin();
		const { device, given } = deviceWith(h);
		h.open({ deviceLock: device });
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect(
			await screen.findByText('This device unlocks secrets its new way now.')
		).toBeTruthy();
		const changed = await h.db.secretKeys.get('c1');
		expect(changed?.unlock).toBe('device');
		expect(new Uint8Array(changed?.credentialId ?? new ArrayBuffer(0))).toEqual(
			new Uint8Array(CREDENTIAL)
		);
		expect(wiped(given)).toBe(true);
		// Sealed under what the device answers, and that alone.
		const asDevice = await unlockKeys(
			h.db,
			'c1',
			{
				kind: 'device',
				credentialId: CREDENTIAL,
				salt: changed?.salt ?? new ArrayBuffer(0),
				answer: new Uint8Array(32).fill(7),
			},
			Date.now()
		);
		expect(asDevice.status === 'unlocked' && asDevice.keys.identities[0]).toEqual(h.identity);
		expect(device.forget).not.toHaveBeenCalled();

		// Held as changed: changing again needs no unlock.
		cleanup();
		h.open({ deviceLock: device });
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await choosePin(h, '1357');
		expect(
			await screen.findByText('This device unlocks secrets its new way now.')
		).toBeTruthy();
		const back = await h.db.secretKeys.get('c1');
		expect(back?.unlock).toBe('pin');
		expect(back?.credentialId).toBeUndefined();
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
		const opened = await unlockKeys(h.db, 'c1', { kind: 'pin', digits: '1357' }, Date.now());
		expect(opened.status === 'unlocked' && opened.keys.identities[0]).toEqual(h.identity);
	});

	it('asks for the unlock again where the device locked while its lock was asked, and changes nothing', async () => {
		const h = await enrolledWithPin();
		const { device, given } = deviceWith(h, undefined, () => {
			h.lock.lock('c1');
		});
		h.open({ deviceLock: device });
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect(await screen.findByLabelText('PIN')).toBeTruthy();
		expect(screen.queryByRole('radio')).toBeNull();
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('pin');
		expect(wiped(given)).toBe(true);
		// Made and checked, and nothing sealed under it.
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
	});

	it('lets go of the passkey it unlocked with, once a new one is made in its place', async () => {
		const h = await enrolledWithDevice();
		const { device } = deviceWith(h, { state: 'made', credentialId: OTHER });
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		await h.user.click(
			await screen.findByRole('button', { name: 'Change how this device unlocks' })
		);
		await h.user.click(await screen.findByRole('radio', { name: DEVICE }));
		await h.user.click(screen.getByRole('button', { name: 'Set unlock' }));

		expect(
			await screen.findByText('This device unlocks secrets its new way now.')
		).toBeTruthy();
		const changed = await h.db.secretKeys.get('c1');
		expect(new Uint8Array(changed?.credentialId ?? new ArrayBuffer(0))).toEqual(
			new Uint8Array(OTHER)
		);
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
	});

	it('lets go of the passkey it unlocked with, once the device is set up again from the recovery key', async () => {
		const h = await enrolledWithDevice(8);
		const { device } = deviceWith(h);
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		await h.user.click(await screen.findByRole('button', { name: 'Unlock' }));
		await h.user.click(await screen.findByRole('button', { name: 'Use the recovery key' }));
		await typeKey(h, encodeIdentity(h.identity));
		expect(device.forget).not.toHaveBeenCalled();
		await choosePin(h);

		await screen.findByText('This device can unlock secrets now.');
		expect((await h.db.secretKeys.get('c1'))?.unlock).toBe('pin');
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
	});

	it('lets go of the passkey it unlocked with, once its key is removed', async () => {
		const h = await enrolledWithDevice();
		const { device } = deviceWith(h);
		h.open({ deviceLock: device });
		await h.user.click(await screen.findByRole('button', { name: 'Remove from this device' }));
		await h.user.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(async () => {
			expect(await h.db.secretKeys.get('c1')).toBeUndefined();
		});
		expect(forgotten(device)).toEqual([[1, 2, 3]]);
	});
});
