import { act, cleanup, render, screen } from '@testing-library/react';
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
import { createSecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { enrol, type Unlock, type UnlockedKeys, unlockKeys } from '../src/store/secretKeys.js';

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
}: { keyFile?: 'ours' | 'theirs' | 'none'; enrolled?: boolean } = {}) => {
	const db = createDatabase(`note-secrets-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	const identity = generateIdentity();
	if (keyFile !== 'none') {
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
			{ db, lock, copy, report: (problem) => told.push(problem) }
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
	const sealedFor = async (words: string, key = identity) => {
		const to = parseRecipient(recipientOf(key));
		if (to === undefined) throw new Error('not a recipient');
		return sealSecret(words, to);
	};
	return { db, identity, lock, told, copy, secrets, unlock, sealedFor, user: userEvent.setup() };
};

describe('whether a secret can be made here', () => {
	it('is so where the source is set up and this device holds its key, locked or not', async () => {
		const h = await setup();
		expect(await h.secrets().host.sealable()).toBe(true);
		expect(h.told).toEqual([]);
	});

	it('says why not, where it is not', async () => {
		const none = await setup({ keyFile: 'none' });
		expect(await none.secrets().host.sealable()).toBe(false);
		expect(none.told.at(-1)?.message).toMatch(/^This source is not set up for secrets/u);
		cleanup();

		const notHere = await setup({ enrolled: false });
		expect(await notHere.secrets().host.sealable()).toBe(false);
		expect(notHere.told.at(-1)?.message).toMatch(/^This device cannot open secrets/u);
		cleanup();

		const replaced = await setup({ keyFile: 'theirs' });
		expect(await replaced.secrets().host.sealable()).toBe(false);
		expect(replaced.told.at(-1)?.message).toMatch(/key was replaced on another device/u);
	});
});

describe('sealing and opening', () => {
	it('seals to this device’s key with the device locked, and opens what it sealed once unlocked', async () => {
		const h = await setup();
		const sealed = await h.secrets().host.seal('the door code');
		if (sealed.state !== 'sealed') throw new Error('not sealed');
		expect(h.lock.isUnlocked('c1')).toBe(false);
		expect(await openSecret(sealed.armor, [h.identity])).toBe('the door code');

		await h.unlock();
		expect(await h.secrets().host.open(sealed.armor)).toEqual({
			state: 'opened',
			words: 'the door code',
		});
	});

	it('asks for the unlock over the note once, for every secret waiting on it', async () => {
		const h = await setup();
		const armor = await h.sealedFor('the door code');

		const first = h.secrets().host.open(armor);
		const second = h.secrets().host.open(armor);
		await h.user.type(await screen.findByLabelText('PIN'), '2468{Enter}');

		expect(await first).toEqual({ state: 'opened', words: 'the door code' });
		expect(await second).toEqual({ state: 'opened', words: 'the door code' });
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(h.lock.isUnlocked('c1')).toBe(true);
	});

	it('opens nothing where the unlock is cancelled', async () => {
		const h = await setup();
		const opening = h.secrets().host.open(await h.sealedFor('the door code'));
		await screen.findByLabelText('PIN');
		await h.user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(await opening).toEqual({ state: 'locked' });
	});

	it('says a secret was made with another key, rather than that the unlock was wrong', async () => {
		const h = await setup();
		await h.unlock();
		const theirs = await h.sealedFor('theirs', generateIdentity());

		expect(await h.secrets().host.open(theirs)).toEqual({ state: 'other' });
		expect(await h.secrets().host.open('not armor')).toEqual({ state: 'unreadable' });
	});

	it('opens with copies, so the lock wiping its own meanwhile changes nothing', async () => {
		const h = await setup();
		await h.unlock();
		const armor = await h.sealedFor('the door code');

		const opening = h.secrets().host.open(armor);
		h.lock.lock();

		expect(await opening).toEqual({ state: 'opened', words: 'the door code' });
	});

	it('says where this device cannot open the source’s secrets at all', async () => {
		const h = await setup({ enrolled: false });
		expect(await h.secrets().host.open(await h.sealedFor('x'))).toEqual({ state: 'locked' });
		expect(h.told.at(-1)?.message).toMatch(/^This device cannot open secrets/u);
		expect(await h.secrets().host.seal('x')).toEqual({ state: 'refused' });
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
