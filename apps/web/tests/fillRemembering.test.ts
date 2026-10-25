import '../src/jitless.js';

import {
	pageSite,
	readVaultPayload,
	type Site,
	VAULT_FOLDER,
	vaultArmor,
	vaultBody,
	vaultPayload,
} from '@skysa/core';
import { describe, expect, it } from 'vitest';

import type { Match } from '../src/fill/matches.js';
import {
	BOOKMARKLET_REVISION,
	FILL_MESSAGE,
	FILL_VERSION,
	type Hello,
} from '../src/fill/protocol.js';
import { offerFor, saveLogin, typedLogin, updateLogin } from '../src/fill/remembering.js';
import {
	generateIdentity,
	openSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';
import { loadAge } from '../src/secrets/loadAge.js';
import { createNote } from '../src/store/notes.js';
import { enrol } from '../src/store/secretKeys.js';
import { freshDatabase } from './support/db.js';

/**
 * Remembering a password typed on a site, from the fill window
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"): what is offered for it,
 * and Save and Update, which seal as Passwords does and lose nothing.
 */

const site = (origin: string): Site => {
	const found = pageSite(origin);
	if (found === undefined) throw new Error(origin);
	return found;
};

const PAGE = site('https://login.example.com');

const match = (more: Partial<Match> = {}): Match => ({
	connectionId: 'c1',
	noteId: 'n1',
	label: 'Example',
	username: 'ada',
	savedFor: PAGE,
	holdsTyped: false,
	body: '',
	...more,
});

const hello = (username: string, password: string, newPassword = ''): Hello => ({
	type: FILL_MESSAGE,
	v: FILL_VERSION,
	b: BOOKMARKLET_REVISION,
	step: 'hello',
	username,
	password,
	newPassword,
	fields: { username: true, password: true, newPassword: newPassword !== '' },
});

describe('what the page’s fields held', () => {
	it('is the new password, where the form asks for one, else the password', () => {
		expect(typedLogin(hello('ada', 'old', 'n3w'))).toEqual({
			username: 'ada',
			password: 'n3w',
		});
		expect(typedLogin(hello('ada', 'typed'))).toEqual({ username: 'ada', password: 'typed' });
	});

	it('is nothing to remember where no password was typed', () => {
		expect(typedLogin(hello('ada', ''))).toBeUndefined();
	});
});

describe('what is offered for a password typed', () => {
	const typed = { username: 'ada', password: 'n3w' };

	it('is nothing more where a login holds it already', () => {
		expect(offerFor(typed, [match({ holdsTyped: true })], PAGE)).toEqual({ kind: 'saved' });
		expect(
			offerFor({ username: '', password: 'n3w' }, [match({ holdsTyped: true })], PAGE)
		).toEqual({ kind: 'saved' });
	});

	it('is Update where one login for this very site has its username', () => {
		const only = match();

		expect(offerFor(typed, [only, match({ username: 'grace' })], PAGE)).toEqual({
			kind: 'update',
			match: only,
		});
	});

	it('is Save where which one it replaces is not known', () => {
		// Saved for a site above the page's.
		expect(offerFor(typed, [match({ savedFor: site('https://example.com') })], PAGE)).toEqual({
			kind: 'save',
		});
		// Two of that username.
		expect(offerFor(typed, [match(), match({ noteId: 'n2' })], PAGE)).toEqual({
			kind: 'save',
		});
		// No username, on the page or in the login.
		expect(
			offerFor({ username: '', password: 'n3w' }, [match({ username: '' })], PAGE)
		).toEqual({ kind: 'save' });
		expect(offerFor(typed, [], PAGE)).toEqual({ kind: 'save' });
	});
});

const setup = async ({ keyFile = 'ours' }: { keyFile?: 'ours' | 'theirs' } = {}) => {
	const db = freshDatabase();
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	const identity = generateIdentity();
	await db.keyFiles.put({
		connectionId: 'c1',
		state: 'ok',
		recipient: recipientOf(keyFile === 'ours' ? identity : generateIdentity()),
		version: 'v1',
	});
	await enrol(db, {
		connectionId: 'c1',
		recipient: recipientOf(identity),
		identities: [identity],
		unlock: { kind: 'pin', digits: '2468' },
		rounds: 1000,
	});
	const to = parseRecipient(recipientOf(identity));
	if (to === undefined) throw new Error('no recipient');
	const item = (kept: Readonly<Record<string, unknown>> = {}) =>
		createNote(db, {
			connectionId: 'c1',
			folderPath: VAULT_FOLDER,
			title: 'Example',
			body: vaultBody(
				sealSecret(
					vaultPayload({ username: 'ada', password: 'old', notes: 'kept' }, kept),
					to
				)
			),
		});
	const payloadOf = (body: string) => {
		const armor = vaultArmor(body);
		return armor === undefined ? undefined : readVaultPayload(openSecret(armor, [identity]));
	};
	return { db, identity, item, payloadOf, age: await loadAge() };
};

describe('Save', () => {
	it('writes a new password, sealed to this device’s key, with the page as its Site', async () => {
		const h = await setup();

		const wrote = await saveLogin(h.db, h.age, {
			connectionId: 'c1',
			label: 'login.example.com',
			username: 'ada',
			password: 's3cret',
			site: 'https://login.example.com',
		});

		expect(wrote).toEqual({ state: 'written' });
		const [note] = await h.db.notes.toArray();
		expect(note).toMatchObject({ title: 'login.example.com', dirty: 1 });
		expect(note?.path.startsWith(`${VAULT_FOLDER}/`)).toBe(true);
		expect(h.payloadOf(note?.body ?? '')?.kept).toEqual({
			urls: ['https://login.example.com'],
			username: 'ada',
			password: 's3cret',
			notes: '',
		});
		expect(await h.db.opQueue.count()).toBeGreaterThan(0);
	});

	it('is refused where the source’s key was replaced on another device', async () => {
		const h = await setup({ keyFile: 'theirs' });

		const wrote = await saveLogin(h.db, h.age, {
			connectionId: 'c1',
			label: 'Example',
			username: 'ada',
			password: 's3cret',
			site: '',
		});

		expect(wrote).toMatchObject({ state: 'refused', why: { way: 'open' } });
		expect(await h.db.notes.count()).toBe(0);
	});
});

describe('Update', () => {
	it('puts the password in place of the one saved, which it keeps, and the rest as it was', async () => {
		const h = await setup();
		const note = await h.item({ urls: ['https://login.example.com'], later: 'kept' });

		const wrote = await updateLogin(
			h.db,
			h.age,
			match({ noteId: note.id, body: note.body }),
			'n3w',
			[h.identity],
			() => new Date('2026-10-16T12:00:00.000Z')
		);

		expect(wrote).toEqual({ state: 'written' });
		const stored = await h.db.notes.get(['c1', note.id]);
		expect(stored?.dirty).toBe(1);
		expect(stored?.bodyOrigin).not.toBe(note.bodyOrigin);
		expect(h.payloadOf(stored?.body ?? '')).toEqual({
			fields: { username: 'ada', password: 'n3w', notes: 'kept' },
			kept: {
				urls: ['https://login.example.com'],
				later: 'kept',
				previousPasswords: [{ password: 'old', replacedAt: '2026-10-16T12:00:00.000Z' }],
				username: 'ada',
				password: 'n3w',
				notes: 'kept',
			},
		});
	});

	it('writes nothing over an item changed since it was read', async () => {
		const h = await setup();
		const note = await h.item();

		const wrote = await updateLogin(
			h.db,
			h.age,
			match({ noteId: note.id, body: 'what it was before' }),
			'n3w',
			[h.identity]
		);

		expect(wrote).toEqual({ state: 'changed' });
		expect((await h.db.notes.get(['c1', note.id]))?.body).toBe(note.body);
	});

	it('writes nothing over passwords from before kept in a shape this version does not know', async () => {
		const h = await setup();
		const note = await h.item({ previousPasswords: 'not a list' });

		const wrote = await updateLogin(
			h.db,
			h.age,
			match({ noteId: note.id, body: note.body }),
			'n3w',
			[h.identity]
		);

		expect(wrote).toEqual({ state: 'unknown' });
		expect((await h.db.notes.get(['c1', note.id]))?.body).toBe(note.body);
	});
});
