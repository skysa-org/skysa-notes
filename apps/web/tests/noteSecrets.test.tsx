import { encodeIdentity } from '@skysa/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type NoteSecrets, useNoteSecrets } from '../src/components/noteSecrets.js';
import type { AttachmentProblem } from '../src/editor/attachHost.js';
import {
	generateIdentity,
	openSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';
import { type Age, loadAge } from '../src/secrets/loadAge.js';
import { createSecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	enrol,
	enrolment,
	type Unlock,
	type UnlockedKeys,
	unlockKeys,
} from '../src/store/secretKeys.js';

/**
 * The host an open note's editor opens and seals its secrets through
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"): the source's key, this
 * device's keys, and the tab's lock, with the unlock asked for over the note.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	document.body.replaceChildren();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const PIN: Unlock = { kind: 'pin', digits: '2468' };

const setup = async ({
	keyFile = 'ours',
	enrolled = true,
	age,
}: {
	keyFile?: 'ours' | 'theirs' | 'none' | 'newer' | 'invalid';
	enrolled?: boolean;
	age?: () => Promise<Age>;
} = {}) => {
	const db = createDatabase(`note-secrets-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	const identity = generateIdentity();
	if (keyFile === 'newer' || keyFile === 'invalid') {
		await db.keyFiles.put({ connectionId: 'c1', state: keyFile, version: 'v1' });
	}
	if (keyFile === 'ours' || keyFile === 'theirs') {
		await db.keyFiles.put({
			connectionId: 'c1',
			state: 'ok',
			recipient: recipientOf(keyFile === 'ours' ? identity : generateIdentity()),
			version: 'v1',
		});
	}
	if (enrolled) {
		await enrol(db, {
			connectionId: 'c1',
			recipient: recipientOf(identity),
			identities: [identity],
			unlock: PIN,
			rounds: 1000,
		});
	}
	const lock = createSecretsLock({
		target: {
			visibilityState: 'visible',
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		},
	});
	const told: AttachmentProblem[] = [];
	const copy = vi.fn((_text: string) => Promise.resolve());
	const held = { current: undefined as NoteSecrets | undefined };
	const Probe = () => {
		const secrets = useNoteSecrets(
			{ connectionId: 'c1' },
			{
				db,
				lock,
				copy,
				...(age === undefined ? {} : { age }),
				report: (problem) => told.push(problem),
			}
		);
		held.current = secrets;
		return <>{secrets.dialog}</>;
	};
	render(<Probe />);
	const secrets = () => {
		if (held.current === undefined) throw new Error('not rendered');
		return held.current;
	};
	const unlock = async () => {
		const result = await unlockKeys(db, 'c1', PIN, Date.now());
		if (result.status !== 'unlocked') throw new Error('not unlocked');
		lock.hold(result.keys);
	};
	const sealedFor = (words: string, key = identity) => {
		const to = parseRecipient(recipientOf(key));
		if (to === undefined) throw new Error('not a recipient');
		return sealSecret(words, to);
	};
	return { db, identity, lock, told, copy, secrets, unlock, sealedFor, user: userEvent.setup() };
};

describe('whether a secret can be made here', () => {
	it('is so where the source is set up and this device holds its key, locked or not', async () => {
		const h = await setup();
		const seal = await h.secrets().host.begin();

		expect(seal).toBeDefined();
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(openSecret(seal?.('the door code') ?? '', [h.identity])).toBe('the door code');
		expect(h.told).toEqual([]);
	});

	it.each([
		[
			'the source is not set up',
			{ keyFile: 'none', enrolled: false },
			/^This source is not set up for secrets/u,
		],
		['the device is not enrolled', { enrolled: false }, /^This device cannot open secrets/u],
		[
			'the key was replaced elsewhere',
			{ keyFile: 'theirs' },
			/key was replaced on another device/u,
		],
		['the folder names no key', { keyFile: 'none' }, /no longer names its key/u],
		['a newer app set it up', { keyFile: 'newer' }, /set up by a newer version of the app/u],
		['the key file is not this app’s', { keyFile: 'invalid' }, /that this app did not write/u],
	] as const)('is not, and says so, where %s', async (_, options, said) => {
		const h = await setup(options);

		expect(await h.secrets().host.begin()).toBeUndefined();
		expect(h.told.at(-1)?.message).toMatch(said);
	});

	it('is not, and says so, where the device’s storage fails', async () => {
		const h = await setup();
		vi.spyOn(h.db.keyFiles, 'get').mockRejectedValueOnce(new Error('gone'));

		expect(await h.secrets().host.begin()).toBeUndefined();
		expect(h.told.at(-1)?.message).toBe('That did not work. Try again.');
	});
});

describe('opening', () => {
	it('opens a secret once unlocked, handing back how to seal what it becomes', async () => {
		const h = await setup();
		const armor = h.sealedFor('the door code');
		await h.unlock();

		const opened = await h.secrets().host.open(armor);

		if (opened.state !== 'opened') throw new Error('not opened');
		expect(opened.words).toBe('the door code');
		expect(openSecret(opened.seal('changed'), [h.identity])).toBe('changed');
	});

	it('asks for the unlock over the note once, for every secret waiting on it', async () => {
		const h = await setup();
		const armor = h.sealedFor('the door code');

		const first = h.secrets().host.open(armor);
		const second = h.secrets().host.open(armor);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');

		expect(await first).toMatchObject({ state: 'opened', words: 'the door code' });
		expect(await second).toMatchObject({ state: 'opened', words: 'the door code' });
		await vi.waitFor(() => {
			expect(screen.queryByRole('dialog')).toBeNull();
		});
		expect(h.lock.isUnlocked('c1')).toBe(true);
	});

	it('opens nothing where the unlock is cancelled', async () => {
		const h = await setup();
		const opening = h.secrets().host.open(h.sealedFor('the door code'));
		await screen.findByLabelText('PIN');
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(await opening).toEqual({ state: 'locked' });
	});

	it('says a secret was made with another key, rather than that the unlock was wrong', async () => {
		const h = await setup();
		await h.unlock();
		const theirs = h.sealedFor('theirs', generateIdentity());

		expect(await h.secrets().host.open(theirs)).toEqual({ state: 'other' });
		expect(await h.secrets().host.open('not armor')).toEqual({ state: 'unreadable' });
	});

	/**
	 * The lock wipes its keys in place as it closes. Opened with copies, the
	 * secret still opens, not "made with another key"; and, the device locked
	 * by then, it is not shown.
	 */
	it('shows nothing opened as the lock closed, and never says another key made it', async () => {
		const gate = { open: (): void => undefined };
		const age = vi.fn(
			() =>
				new Promise<Age>((resolve) => {
					gate.open = () => {
						void loadAge().then(resolve);
					};
				})
		);
		const h = await setup({ age });
		await h.unlock();
		const armor = h.sealedFor('the door code');

		const opening = h.secrets().host.open(armor);
		// The keys copied, and the age code on its way.
		await vi.waitFor(() => {
			expect(age).toHaveBeenCalled();
		});
		h.lock.lock();
		gate.open();

		expect(await opening).toEqual({ state: 'locked' });
	});

	it('opens nothing, and says so, where the device’s storage fails', async () => {
		const h = await setup();
		vi.spyOn(h.db.secretKeys, 'get').mockRejectedValueOnce(new Error('gone'));

		expect(await h.secrets().host.open(h.sealedFor('x'))).toEqual({ state: 'locked' });
		expect(h.told.at(-1)?.message).toBe('That did not work. Try again.');
	});

	it('says where this device cannot open the source’s secrets at all', async () => {
		const h = await setup({ enrolled: false });
		expect(await h.secrets().host.open(h.sealedFor('x'))).toEqual({ state: 'locked' });
		expect(h.told.at(-1)?.message).toMatch(/^This device cannot open secrets/u);
	});
});

describe('what the editor is told', () => {
	it('hears the lock close the source, once, and not another source come and go', async () => {
		const h = await setup();
		const heard = vi.fn();
		h.secrets().host.locked(heard);
		const another = {
			connectionId: 'c2',
			recipient: 'age1another',
			identities: [new Uint8Array(32).fill(1)],
			sealedAs: new ArrayBuffer(12),
		} as unknown as UnlockedKeys;
		act(() => {
			h.lock.hold(another);
		});
		await h.unlock();
		act(() => {
			h.lock.lock('c2');
		});
		expect(heard).not.toHaveBeenCalled();

		act(() => {
			h.lock.lock();
		});
		act(() => {
			h.lock.lock();
		});
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it('puts "Insert secret" in the editor that offered itself, and in none once it took that back', async () => {
		const h = await setup();
		const insert = vi.fn();
		const stop = h.secrets().host.receive(insert);
		h.secrets().insert();
		expect(insert).toHaveBeenCalledTimes(1);

		stop();
		h.secrets().insert();
		expect(insert).toHaveBeenCalledTimes(1);
	});

	it('copies words to the clipboard, answering whether they went', async () => {
		const h = await setup();
		expect(await h.secrets().host.copy('the door code')).toBe(true);
		expect(h.copy).toHaveBeenCalledWith('the door code');
		h.copy.mockRejectedValueOnce(new Error('denied'));
		expect(await h.secrets().host.copy('again')).toBe(false);
	});
});

describe('adding the key a secret was made with', () => {
	const typeKey = async (h: Awaited<ReturnType<typeof setup>>, key: Uint8Array) => {
		const field = await screen.findByLabelText('Recovery key');
		await h.user.clear(field);
		await h.user.type(field, `${encodeIdentity(key)}{Enter}`);
	};

	it('takes the key that opens it, keeps it beside the source’s own, and opens the secret', async () => {
		const h = await setup();
		await h.unlock();
		const theirs = generateIdentity();
		const armor = h.sealedFor('from the old notes', theirs);
		expect(await h.secrets().host.open(armor)).toEqual({ state: 'other' });

		const adding = h.secrets().host.addKey(armor);
		expect(await screen.findByRole('dialog', { name: 'Add this secret’s key' })).toBeTruthy();
		await typeKey(h, generateIdentity());
		expect((await screen.findByRole('alert')).textContent).toBe(
			'That key does not open this secret.'
		);
		// What the folder says has been read by now: the key was not replaced.
		expect(
			screen.getByText(
				'Paste or type the key this secret was made with. This device keeps it beside this source’s own key, to open secrets made with it.'
			)
		).toBeTruthy();
		await typeKey(h, theirs);

		expect(await adding).toBe(true);
		// Closed as the promise settles, outside any act: rendered a moment later.
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(await h.secrets().host.open(armor)).toMatchObject({
			state: 'opened',
			words: 'from the old notes',
		});
		// Sealed with the device's keys, under its unlock: the source's own first.
		h.lock.lock();
		const reopened = await unlockKeys(h.db, 'c1', PIN, Date.now());
		if (reopened.status !== 'unlocked') throw new Error('not unlocked');
		expect(reopened.keys.identities).toEqual([h.identity, theirs]);
		expect(reopened.keys.recipient).toBe(recipientOf(h.identity));
	});

	it('keeps the key the folder names as the source’s, first, where it was replaced on another device', async () => {
		const h = await setup();
		await h.unlock();
		const fresh = generateIdentity();
		await h.db.keyFiles.put({
			connectionId: 'c1',
			state: 'ok',
			recipient: recipientOf(fresh),
			version: 'v2',
		});
		const armor = h.sealedFor('after the change', fresh);
		expect(await h.secrets().host.open(armor)).toEqual({ state: 'other' });

		const adding = h.secrets().host.addKey(armor);
		expect(
			await screen.findByText(
				'This source’s key was replaced on another device. Type the new recovery key, or the key this secret was made with.'
			)
		).toBeTruthy();
		await typeKey(h, fresh);

		expect(await adding).toBe(true);
		expect(await h.secrets().host.open(armor)).toMatchObject({
			state: 'opened',
			words: 'after the change',
		});
		expect(await enrolment(h.db, 'c1')).toMatchObject({
			recipient: recipientOf(fresh),
			former: [recipientOf(h.identity)],
		});
		// New secrets are made with it from now on.
		const seal = await h.secrets().host.begin();
		expect(openSecret(seal?.('new') ?? '', [fresh])).toBe('new');
		h.lock.lock();
		const reopened = await unlockKeys(h.db, 'c1', PIN, Date.now());
		if (reopened.status !== 'unlocked') throw new Error('not unlocked');
		expect(reopened.keys.identities).toEqual([fresh, h.identity]);
	});

	it('keeps a secret’s own key beside the others where the source’s was replaced and it is another', async () => {
		const h = await setup();
		await h.unlock();
		await h.db.keyFiles.put({
			connectionId: 'c1',
			state: 'ok',
			recipient: recipientOf(generateIdentity()),
			version: 'v2',
		});
		const theirs = generateIdentity();
		const armor = h.sealedFor('from the old notes', theirs);

		const adding = h.secrets().host.addKey(armor);
		await typeKey(h, theirs);

		expect(await adding).toBe(true);
		expect(await enrolment(h.db, 'c1')).toMatchObject({
			recipient: recipientOf(h.identity),
			former: [],
		});
		h.lock.lock();
		const reopened = await unlockKeys(h.db, 'c1', PIN, Date.now());
		if (reopened.status !== 'unlocked') throw new Error('not unlocked');
		expect(reopened.keys.identities).toEqual([h.identity, theirs]);
	});

	it('lets go of each key typed, the one that opens it and the one that does not', async () => {
		const typed: Uint8Array[] = [];
		const age = async (): Promise<Age> => {
			const real = await loadAge();
			return {
				...real,
				opensSecret: (armor, identities) => {
					typed.push(...identities);
					return real.opensSecret(armor, identities);
				},
			};
		};
		const h = await setup({ age });
		await h.unlock();
		const theirs = generateIdentity();
		const armor = h.sealedFor('x', theirs);

		const adding = h.secrets().host.addKey(armor);
		await typeKey(h, generateIdentity());
		await screen.findByRole('alert');
		await typeKey(h, theirs);

		expect(await adding).toBe(true);
		expect(typed).toHaveLength(2);
		expect(typed.every((key) => key.every((byte) => byte === 0))).toBe(true);
		expect(theirs.some((byte) => byte !== 0)).toBe(true);
	});

	it('unlocks the device first, where it is locked', async () => {
		const h = await setup();
		const theirs = generateIdentity();
		const armor = h.sealedFor('x', theirs);

		const adding = h.secrets().host.addKey(armor);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');
		await typeKey(h, theirs);

		expect(await adding).toBe(true);
		expect(h.lock.keys('c1')?.identities).toHaveLength(2);
	});

	it('adds nothing where it is asked away, or the unlock is', async () => {
		const h = await setup();
		const armor = h.sealedFor('x', generateIdentity());

		const unlocking = h.secrets().host.addKey(armor);
		await screen.findByLabelText('PIN');
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await unlocking).toBe(false);

		await h.unlock();
		const adding = h.secrets().host.addKey(armor);
		await screen.findByLabelText('Recovery key');
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await adding).toBe(false);
		expect(h.lock.keys('c1')?.identities).toHaveLength(1);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('adds nothing where the device locked as the key was typed', async () => {
		const h = await setup();
		await h.unlock();
		const theirs = generateIdentity();
		const armor = h.sealedFor('x', theirs);

		const adding = h.secrets().host.addKey(armor);
		await screen.findByLabelText('Recovery key');
		h.lock.lock();
		await typeKey(h, theirs);

		expect(await adding).toBe(false);
		const record = await unlockKeys(h.db, 'c1', PIN, Date.now());
		expect(record.status === 'unlocked' && record.keys.identities).toHaveLength(1);
	});

	it('says so, and locks, where another window sealed the keys again meanwhile', async () => {
		const h = await setup();
		await h.unlock();
		const theirs = generateIdentity();
		const armor = h.sealedFor('x', theirs);
		const adding = h.secrets().host.addKey(armor);
		await screen.findByLabelText('Recovery key');
		// Another window sealed them again.
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: recipientOf(h.identity),
			identities: [h.identity],
			unlock: PIN,
			rounds: 1000,
		});

		await typeKey(h, theirs);

		expect((await screen.findByRole('alert')).textContent).toBe(
			'The key on this device changed in another window. Unlock it again, then try again.'
		);
		expect(h.lock.isUnlocked('c1')).toBe(false);
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await adding).toBe(false);
	});
});
