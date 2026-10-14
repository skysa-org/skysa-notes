import { armor, encrypt, secretBlocksIn } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	generateIdentity,
	keysFor,
	openSecret,
	opensSecret,
	parseRecipient,
	recipientOf,
	resealSecrets,
	scanReplacing,
	sealSecret,
} from '../src/secrets/age.js';
import { createDatabase, type NoteRecord, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { noteById, updateNote } from './noteRows.js';

/**
 * Encrypting a source's secrets to its new key (docs/ARCHITECTURE.md §7,
 * "Replacing the key"): what the old keys open, in place, note by note, and
 * nothing else.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const setup = async () => {
	const db = createDatabase(`reseal-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	return db;
};

const sealedFor = (words: string, identity: Uint8Array): string => {
	const to = parseRecipient(recipientOf(identity));
	if (to === undefined) throw new Error('not a recipient');
	return sealSecret(words, to);
};

/** A secret's fence, each of its lines after `prefix`. */
const fence = (armor: string, prefix = ''): string =>
	['```age', ...armor.split('\n'), '```'].map((line) => `${prefix}${line}`).join('\n');

const noteWith = (db: NotesDatabase, title: string, body: string): Promise<NoteRecord> =>
	createNote(db, { connectionId: 'c1', title, body });

const bodyOf = async (db: NotesDatabase, note: NoteRecord): Promise<string> =>
	(await noteById(db, note.id))?.body ?? '';

/** Which of `keys` opens each secret in `body`, by its place in `keys`. */
const madeWith = (body: string, keys: readonly Uint8Array[]): number[] =>
	secretBlocksIn(body).map((block) => keys.findIndex((key) => opensSecret(block, [key])));

const old = generateIdentity();
const fresh = generateIdentity();
const other = generateIdentity();
const KEYS = [old, fresh, other];

const going = () => true;
const input = { fresh: [fresh], recipient: recipientOf(fresh), old: [old], going };

describe('encrypting a source’s secrets to its new key', () => {
	it('encrypts what an old key opens to the new one, in its place, and leaves the rest', async () => {
		const db = await setup();
		const mixed = await noteWith(
			db,
			'Mixed',
			[
				'# Codes',
				'',
				fence(sealedFor('front door', old)),
				'',
				'- In a list:',
				'',
				fence(sealedFor('back door', old), '  '),
				'',
				fence(sealedFor('theirs', other)),
				'',
				fence(sealedFor('already', fresh)),
				'',
				'The end.',
				'',
			].join('\n')
		);
		const plain = await noteWith(db, 'Plain', 'No secrets here.\n');
		const theirs = await noteWith(db, 'Theirs', `${fence(sealedFor('theirs', other))}\n`);
		const before = await db.notes.toArray();

		expect(await resealSecrets(db, 'c1', input)).toEqual({
			secrets: 2,
			notes: 1,
			stopped: false,
		});

		const body = await bodyOf(db, mixed);
		expect(madeWith(body, KEYS)).toEqual([1, 1, 2, 1]);
		expect(
			secretBlocksIn(body)
				.slice(0, 2)
				.map((block) => openSecret(block, [fresh]))
		).toEqual(['front door', 'back door']);
		// Nothing but the armor moved: the list still holds its fence.
		const without = (text: string) =>
			secretBlocksIn(text).reduce((sofar, block) => {
				const lines = block.split('\n');
				return lines.reduce((each, line) => each.replace(line, ''), sofar);
			}, text);
		expect(without(body)).toBe(
			without(before.find((note) => note.id === mixed.id)?.body ?? '')
		);
		expect(await noteById(db, plain.id)).toEqual(before.find((note) => note.id === plain.id));
		expect(await noteById(db, theirs.id)).toEqual(before.find((note) => note.id === theirs.id));
	});

	it('says what it would do before it does it', async () => {
		const db = await setup();
		await noteWith(
			db,
			'A',
			`${fence(sealedFor('a', old))}\n\n${fence(sealedFor('b', other))}\n`
		);
		await noteWith(
			db,
			'B',
			`${fence(sealedFor('c', old))}\n\n${fence(sealedFor('d', fresh))}\n`
		);
		await noteWith(db, 'C', `${fence(sealedFor('e', generateIdentity()))}\n`);
		const gone = await noteWith(db, 'Gone', `${fence(sealedFor('f', old))}\n`);
		await updateNote(db, gone.id, { deletedLocally: 1 });

		expect(await scanReplacing(db, 'c1', [fresh], [old])).toEqual({
			resealing: 2,
			others: 2,
			otherNotes: 2,
		});
	});

	it('stops between notes once it is told to, for good, leaving the rest as they were', async () => {
		const db = await setup();
		const notes = await Promise.all(
			['A', 'B', 'C'].map((title) => noteWith(db, title, `${fence(sealedFor(title, old))}\n`))
		);
		const asked = { count: 0 };

		const done = await resealSecrets(db, 'c1', {
			...input,
			// Unlocked again after it stopped: it does not start again.
			going: () => {
				asked.count += 1;
				return asked.count !== 2;
			},
		});

		expect(done).toEqual({ secrets: 1, notes: 1, stopped: true });
		// One of them, whichever was read first.
		const made = await Promise.all(
			notes.map(async (note) => madeWith(await bodyOf(db, note), KEYS))
		);
		expect(made.flat().sort()).toEqual([0, 0, 1]);
	});

	it('passes over a deleted note, and leaves a secret whose words do not open after all', async () => {
		const db = await setup();
		const gone = await noteWith(db, 'Gone', `${fence(sealedFor('a', old))}\n`);
		await updateNote(db, gone.id, { deletedLocally: 1 });
		// The header opens, and the words after it were changed: they do not.
		const armor = sealedFor('x'.repeat(2000), old).split('\n');
		const at = armor.length - 3;
		const line = armor[at] ?? '';
		const broken = armor.map((each, place) =>
			place === at ? `${line.startsWith('A') ? 'B' : 'A'}${line.slice(1)}` : each
		);
		const damaged = await noteWith(db, 'Damaged', `${fence(broken.join('\n'))}\n`);

		expect(await resealSecrets(db, 'c1', input)).toEqual({
			secrets: 0,
			notes: 0,
			stopped: false,
		});
		expect(madeWith(await bodyOf(db, gone), KEYS)).toEqual([0]);
		expect(await bodyOf(db, damaged)).toBe(`${fence(broken.join('\n'))}\n`);
	});

	it('leaves a secret the new key opens as well as an old one', async () => {
		const db = await setup();
		const both = armor(
			encrypt(
				new TextEncoder().encode('for both'),
				[old, fresh].map((key) => parseRecipient(recipientOf(key)) ?? new Uint8Array())
			)
		).replace(/\n$/u, '');
		const note = await noteWith(db, 'Both', `${fence(both)}\n`);

		expect(await scanReplacing(db, 'c1', [fresh], [old])).toMatchObject({ resealing: 0 });
		expect(await resealSecrets(db, 'c1', input)).toMatchObject({ secrets: 0, notes: 0 });
		expect(await bodyOf(db, note)).toBe(`${fence(both)}\n`);
	});

	it('refuses a recipient that does not read', async () => {
		const db = await setup();
		await expect(
			resealSecrets(db, 'c1', { ...input, recipient: 'age1nope' })
		).rejects.toThrow();
	});
});

describe('the keys a source had', () => {
	it('are the ones a device holds whose recipient is one of them', () => {
		expect(keysFor([old, fresh, other], [recipientOf(other), recipientOf(old)])).toEqual([
			old,
			other,
		]);
	});
});
