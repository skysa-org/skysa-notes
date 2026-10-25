import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSecretsLock } from '../src/secrets/lock.js';
import {
	changeUnlock,
	type DeviceUnlock,
	enrol,
	enrolment,
	FREE_TRIES,
	isAcceptedUnlock,
	MAX_TRIES,
	PBKDF2_ROUNDS,
	replaceKeys,
	TRY_WAIT_MS,
	type Unlock,
	type UnlockedKeys,
	unlockKeys,
} from '../src/store/secretKeys.js';
import { freshDatabase } from './support/db.js';

/**
 * A source's keys on this device, sealed under how it unlocks
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"). PBKDF2 runs at a few rounds
 * here, and at its full count once, to see that it is what is kept.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

const ROUNDS = 1000;
const RECIPIENT = 'age1320ux0hct0gutc9fu789mqlqjns4fv84w9cz3ytr9mh8fx86fsasr4slrh';
const AT = 1_000_000;

const PIN: Unlock = { kind: 'pin', digits: '2468' };
const PATTERN: Unlock = { kind: 'pattern', dots: [0, 4, 8, 5] };
const PASSWORD: Unlock = { kind: 'password', text: 'correct horse' };

const identity = (fill: number) => new Uint8Array(32).fill(fill);

const setup = async () => {
	const db = freshDatabase();
	await db.syncState.put({ connectionId: 'c1', clientId: 'install' });
	const enrolled = async (unlock: Unlock = PIN, identities = [identity(7), identity(9)]) => {
		const keys = await enrol(db, {
			connectionId: 'c1',
			recipient: RECIPIENT,
			identities,
			unlock,
			rounds: ROUNDS,
		});
		if (keys === undefined) throw new Error('not enrolled');
		return keys;
	};
	return { db, enrolled };
};

const unlocked = (result: Awaited<ReturnType<typeof unlockKeys>>): UnlockedKeys => {
	if (result.status !== 'unlocked') throw new Error(`not unlocked: ${result.status}`);
	return result.keys;
};

describe('an unlock', () => {
	it.each<[string, Unlock, boolean]>([
		['a pattern of four dots', PATTERN, true],
		['a pattern of three', { kind: 'pattern', dots: [0, 1, 2] }, false],
		['a pattern through a dot twice', { kind: 'pattern', dots: [0, 1, 2, 1] }, false],
		['a pattern off the grid', { kind: 'pattern', dots: [0, 1, 2, 9] }, false],
		['a PIN of four digits', PIN, true],
		['a PIN of three', { kind: 'pin', digits: '246' }, false],
		['a PIN with a letter in it', { kind: 'pin', digits: '24a8' }, false],
		['a password of eight characters', { kind: 'password', text: 'abcdefgh' }, true],
		['a password of seven', { kind: 'password', text: 'abcdefg' }, false],
		[
			'a password of four emoji, eight UTF-16 units',
			{ kind: 'password', text: '🔑🔑🔑🔑' },
			false,
		],
	])('is %s: %s', (_, unlock, accepted) => {
		expect(isAcceptedUnlock(unlock)).toBe(accepted);
	});
});

describe('enrolling a device', () => {
	it('keeps the keys sealed, with the recipient they were enrolled with, and holds them unlocked', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled();

		expect(keys.recipient).toBe(RECIPIENT);
		expect(keys.identities).toEqual([identity(7), identity(9)]);
		const record = await db.secretKeys.get('c1');
		expect(record).toMatchObject({
			recipient: RECIPIENT,
			unlock: 'pin',
			rounds: ROUNDS,
			tries: 0,
		});
		expect(await enrolment(db, 'c1')).toEqual({
			recipient: RECIPIENT,
			unlock: 'pin',
			tries: 0,
			former: [],
		});
	});

	it('keeps the keys as they were given, where the caller wipes its own while they are sealed', async () => {
		const { db } = await setup();
		const given = [identity(7)];

		const enrolling = enrol(db, {
			connectionId: 'c1',
			recipient: RECIPIENT,
			identities: given,
			unlock: PIN,
			rounds: ROUNDS,
		});
		given.forEach((each) => each.fill(0));
		const keys = await enrolling;

		expect(keys?.identities).toEqual([identity(7)]);
		expect(unlocked(await unlockKeys(db, 'c1', PIN, AT)).identities).toEqual([identity(7)]);
	});

	it('keeps neither the keys nor the unlock as they are', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PASSWORD, [identity(0xab)]);
		const record = await db.secretKeys.get('c1');
		const stored = new Uint8Array(record?.sealed ?? new ArrayBuffer(0));

		// 32 bytes of key and AES-GCM's 16-byte tag, and no run of the key in it.
		expect(stored.length).toBe(48);
		expect(stored.filter((byte) => byte === 0xab).length).toBeLessThan(8);
		expect(JSON.stringify(record)).not.toContain('correct horse');
	});

	it('makes the key with PBKDF2 at 600,000 rounds where it is not told otherwise', async () => {
		const { db } = await setup();
		await enrol(db, {
			connectionId: 'c1',
			recipient: RECIPIENT,
			identities: [identity(1)],
			unlock: PIN,
		});
		expect((await db.secretKeys.get('c1'))?.rounds).toBe(PBKDF2_ROUNDS);
		expect(PBKDF2_ROUNDS).toBe(600_000);
	});

	it('keeps nothing for a source that has left the device', async () => {
		const { db } = await setup();
		await db.syncState.delete('c1');
		expect(
			await enrol(db, {
				connectionId: 'c1',
				recipient: RECIPIENT,
				identities: [identity(1)],
				unlock: PIN,
				rounds: ROUNDS,
			})
		).toBeUndefined();
		expect(await db.secretKeys.count()).toBe(0);
	});

	it('refuses an unlock that is too short, and no keys at all', async () => {
		const { db } = await setup();
		const input = { connectionId: 'c1', recipient: RECIPIENT, rounds: ROUNDS };
		await expect(
			enrol(db, {
				...input,
				identities: [identity(1)],
				unlock: { kind: 'pin', digits: '12' },
			})
		).rejects.toThrow();
		await expect(enrol(db, { ...input, identities: [], unlock: PIN })).rejects.toThrow();
		expect(await db.secretKeys.count()).toBe(0);
	});
});

describe('unlocking', () => {
	it('opens the keys with the unlock they were sealed under', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PATTERN);
		const keys = unlocked(await unlockKeys(db, 'c1', PATTERN, AT));
		expect(keys.identities).toEqual([identity(7), identity(9)]);
		expect(keys.recipient).toBe(RECIPIENT);
	});

	it('takes a password typed in another normal form as the same password', async () => {
		const { db, enrolled } = await setup();
		await enrolled({ kind: 'password', text: 'café au lait' });
		const result = await unlockKeys(db, 'c1', { kind: 'password', text: 'café au lait' }, AT);
		expect(result.status).toBe('unlocked');
	});

	it('counts a wrong try, and says what the device unlocks with, uncounted, to a try of another kind', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);
		expect(await unlockKeys(db, 'c1', { kind: 'pin', digits: '1357' }, AT)).toEqual({
			status: 'wrong',
			triesLeft: MAX_TRIES - 1,
		});
		expect(await unlockKeys(db, 'c1', { kind: 'pattern', dots: [2, 4, 6, 8] }, AT)).toEqual({
			status: 'otherWay',
			unlock: 'pin',
		});
		expect((await db.secretKeys.get('c1'))?.tries).toBe(1);
	});

	it('sets the count back with a right try', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);
		await unlockKeys(db, 'c1', { kind: 'pin', digits: '0000' }, AT);
		await unlockKeys(db, 'c1', PIN, AT);
		const record = await db.secretKeys.get('c1');
		expect(record?.tries).toBe(0);
		expect(record?.triedAt).toBeUndefined();
	});

	it('makes each try after the fifth wrong one wait 30 s, and tries nothing sooner', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);
		const wrong: Unlock = { kind: 'pin', digits: '0000' };
		for (let at = 1; at < FREE_TRIES; at += 1) {
			expect(await unlockKeys(db, 'c1', wrong, AT)).not.toHaveProperty('waitUntil');
		}
		expect(await unlockKeys(db, 'c1', wrong, AT)).toEqual({
			status: 'wrong',
			triesLeft: MAX_TRIES - FREE_TRIES,
			waitUntil: AT + TRY_WAIT_MS,
		});

		// Even the right one waits, and is not counted.
		expect(await unlockKeys(db, 'c1', PIN, AT + TRY_WAIT_MS - 1)).toEqual({
			status: 'wait',
			until: AT + TRY_WAIT_MS,
		});
		expect((await db.secretKeys.get('c1'))?.tries).toBe(FREE_TRIES);
		expect((await unlockKeys(db, 'c1', PIN, AT + TRY_WAIT_MS)).status).toBe('unlocked');
	});

	it('deletes the device’s copy at the tenth wrong try in a row', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);
		const wrong: Unlock = { kind: 'pin', digits: '0000' };
		const results = [];
		for (let at = 0; at < MAX_TRIES; at += 1) {
			results.push(await unlockKeys(db, 'c1', wrong, AT + at * TRY_WAIT_MS));
		}
		expect(results.at(-2)).toMatchObject({ status: 'wrong', triesLeft: 1 });
		expect(results.at(-1)).toEqual({ status: 'forgotten' });
		expect(await db.secretKeys.get('c1')).toBeUndefined();
		expect(await unlockKeys(db, 'c1', PIN, AT + MAX_TRIES * TRY_WAIT_MS)).toEqual({
			status: 'none',
		});
	});

	it('counts tries made at once, before any is checked', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);
		const wrong: Unlock = { kind: 'pin', digits: '0000' };
		await Promise.all([0, 1, 2].map(() => unlockKeys(db, 'c1', wrong, AT)));
		expect((await db.secretKeys.get('c1'))?.tries).toBe(3);
	});

	it('says when the device holds no keys for the source', async () => {
		const { db } = await setup();
		expect(await unlockKeys(db, 'c1', PIN, AT)).toEqual({ status: 'none' });
	});
});

describe('changing how a device unlocks', () => {
	it('takes the keys unlocked, with no recovery key, and the old unlock opens nothing after', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled(PIN);

		const changed = await changeUnlock(db, keys, PATTERN, ROUNDS);

		expect(changed?.identities).toEqual(keys.identities);
		expect(changed?.identities[0]).not.toBe(keys.identities[0]);
		expect((await db.secretKeys.get('c1'))?.unlock).toBe('pattern');
		expect(await unlockKeys(db, 'c1', PIN, AT)).toEqual({
			status: 'otherWay',
			unlock: 'pattern',
		});
		expect(unlocked(await unlockKeys(db, 'c1', PATTERN, AT)).identities).toEqual(
			keys.identities
		);
	});

	it('gives keys of their own, which a tab can hold in place of the ones it had, and change again', async () => {
		const { db, enrolled } = await setup();
		const lock = createSecretsLock({
			target: {
				visibilityState: 'visible',
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		lock.hold(await enrolled(PIN));

		const once = await changeUnlock(db, lock.keys('c1') as UnlockedKeys, PATTERN, ROUNDS);
		lock.hold(once as UnlockedKeys);
		const twice = await changeUnlock(db, lock.keys('c1') as UnlockedKeys, PASSWORD, ROUNDS);
		lock.hold(twice as UnlockedKeys);
		lock.lock();

		expect(unlocked(await unlockKeys(db, 'c1', PASSWORD, AT)).identities).toEqual([
			identity(7),
			identity(9),
		]);
	});

	it('keeps the keys it was given where the tab locks while the new unlock is derived', async () => {
		const { db, enrolled } = await setup();
		const lock = createSecretsLock({
			target: {
				visibilityState: 'visible',
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		lock.hold(await enrolled(PIN));

		const changing = changeUnlock(db, lock.keys('c1') as UnlockedKeys, PATTERN, ROUNDS);
		lock.lock();
		const changed = await changing;

		expect(changed?.identities).toEqual([identity(7), identity(9)]);
		expect(unlocked(await unlockKeys(db, 'c1', PATTERN, AT)).identities).toEqual([
			identity(7),
			identity(9),
		]);
	});

	it('refuses keys that were wiped, and keeps the record it had', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled(PIN);

		await expect(
			changeUnlock(db, { ...keys, identities: [identity(7), identity(0)] }, PATTERN, ROUNDS)
		).rejects.toThrow();
		expect((await db.secretKeys.get('c1'))?.unlock).toBe('pin');
	});

	it('changes nothing where the keys were sealed again in another tab since these were opened', async () => {
		const { db, enrolled } = await setup();
		const here = await enrolled(PIN);
		await enrolled(PASSWORD, [identity(7), identity(9), identity(11)]);

		expect(await changeUnlock(db, here, PATTERN, ROUNDS)).toBeUndefined();
		expect((await db.secretKeys.get('c1'))?.unlock).toBe('password');
	});

	it('refuses an unlock that is too short', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled(PIN);
		await expect(
			changeUnlock(db, keys, { kind: 'password', text: 'short' }, ROUNDS)
		).rejects.toThrow();
		expect((await db.secretKeys.get('c1'))?.unlock).toBe('pin');
	});
});

describe('replacing the source’s key on a device', () => {
	const NEW = 'age1newrecipient';

	it('keeps the given keys under the same unlock, for the new recipient', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled(PIN);

		const replaced = await replaceKeys(db, keys, NEW, [identity(3), ...keys.identities]);

		expect(replaced?.recipient).toBe(NEW);
		expect(replaced?.identities).toEqual([identity(3), identity(7), identity(9)]);
		expect(await enrolment(db, 'c1')).toMatchObject({
			recipient: NEW,
			unlock: 'pin',
			former: [RECIPIENT],
		});
		expect(unlocked(await unlockKeys(db, 'c1', PIN, AT)).identities).toEqual([
			identity(3),
			identity(7),
			identity(9),
		]);
	});

	it('remembers each recipient the key had, through a change of unlock, and not one it goes back to', async () => {
		const { db, enrolled } = await setup();
		const first = await replaceKeys(db, await enrolled(PIN), NEW, [identity(3), identity(7)]);
		if (first === undefined) throw new Error('not replaced');
		const added = await replaceKeys(db, first, NEW, [...first.identities, identity(5)]);
		expect((await enrolment(db, 'c1'))?.former).toEqual([RECIPIENT]);
		if (added === undefined) throw new Error('not added');

		const again = await replaceKeys(db, added, 'age1third', added.identities);
		if (again === undefined) throw new Error('not replaced');
		expect((await enrolment(db, 'c1'))?.former).toEqual([RECIPIENT, NEW]);
		const changed = await changeUnlock(db, again, PASSWORD, ROUNDS);
		expect((await enrolment(db, 'c1'))?.former).toEqual([RECIPIENT, NEW]);
		if (changed === undefined) throw new Error('not changed');

		await replaceKeys(db, changed, RECIPIENT, changed.identities);
		expect((await enrolment(db, 'c1'))?.former).toEqual([NEW, 'age1third']);
	});

	it('keeps the keys it was given where the tab locks while they are sealed', async () => {
		const { db, enrolled } = await setup();
		const lock = createSecretsLock({
			target: {
				visibilityState: 'visible',
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		lock.hold(await enrolled(PIN));
		const held = lock.keys('c1') as UnlockedKeys;

		const replacing = replaceKeys(db, held, NEW, [identity(3), ...held.identities]);
		lock.lock();
		await replacing;

		expect(unlocked(await unlockKeys(db, 'c1', PIN, AT)).identities).toEqual([
			identity(3),
			identity(7),
			identity(9),
		]);
	});

	it('changes nothing where the keys were sealed again in another tab, or were wiped', async () => {
		const { db, enrolled } = await setup();
		const here = await enrolled(PIN);
		await enrolled(PASSWORD, [identity(7), identity(9), identity(11)]);

		expect(await replaceKeys(db, here, NEW, [identity(3)])).toBeUndefined();
		await expect(replaceKeys(db, here, NEW, [identity(0)])).rejects.toThrow();
		await expect(replaceKeys(db, here, NEW, [])).rejects.toThrow();
		expect(await enrolment(db, 'c1')).toMatchObject({
			recipient: RECIPIENT,
			unlock: 'password',
		});
	});
});

describe('the device’s own lock', () => {
	const credentialId = new Uint8Array([1, 2, 3, 4]).buffer;
	const salt = new Uint8Array(32).fill(5).buffer;
	/** What the passkey answers, as a fresh copy each time, as a browser gives it. */
	const answered = (fill = 0x42): DeviceUnlock => ({
		kind: 'device',
		credentialId,
		salt,
		answer: new Uint8Array(32).fill(fill),
	});

	it('is an answer of 32 bytes from a passkey', () => {
		expect(isAcceptedUnlock(answered())).toBe(true);
		expect(
			isAcceptedUnlock({ kind: 'device', credentialId, salt, answer: new Uint8Array(16) })
		).toBe(false);
		expect(isAcceptedUnlock({ ...answered(), credentialId: new ArrayBuffer(0) })).toBe(false);
	});

	it('seals the keys under what it answered, with the passkey and its salt kept, and no rounds', async () => {
		const { db, enrolled } = await setup();
		await enrolled(answered());

		expect(await db.secretKeys.get('c1')).toMatchObject({
			unlock: 'device',
			rounds: 0,
			credentialId,
			salt,
		});
		expect(await enrolment(db, 'c1')).toEqual({
			recipient: RECIPIENT,
			unlock: 'device',
			tries: 0,
			device: { credentialId, salt },
			former: [],
		});
		const stored = new Uint8Array(
			(await db.secretKeys.get('c1'))?.sealed ?? new ArrayBuffer(0)
		);
		expect(stored.filter((byte) => byte === 0x42).length).toBeLessThan(8);
	});

	it('opens the keys with the same answer, and leaves the answer it was given as it was', async () => {
		const { db, enrolled } = await setup();
		await enrolled(answered());
		const given = answered();

		expect(unlocked(await unlockKeys(db, 'c1', given, AT)).identities).toEqual([
			identity(7),
			identity(9),
		]);
		expect(given.answer.every((byte) => byte === 0x42)).toBe(true);
	});

	it('counts no try where another answer does not open them, and says the lock no longer does', async () => {
		const { db, enrolled } = await setup();
		await enrolled(answered());

		const results = await Promise.all(
			Array.from({ length: MAX_TRIES + 1 }, () => unlockKeys(db, 'c1', answered(0x43), AT))
		);

		expect(new Set(results.map((result) => result.status))).toEqual(new Set(['changed']));
		expect((await db.secretKeys.get('c1'))?.tries).toBe(0);
		expect(unlocked(await unlockKeys(db, 'c1', answered(), AT)).identities).toHaveLength(2);
	});

	it('says what the device unlocks with where it unlocks another way now', async () => {
		const { db, enrolled } = await setup();
		await enrolled(PIN);

		expect(await unlockKeys(db, 'c1', answered(), AT)).toEqual({
			status: 'otherWay',
			unlock: 'pin',
		});
		expect((await db.secretKeys.get('c1'))?.tries).toBe(0);
	});

	it('says the device unlocks another way now where another passkey was made since', async () => {
		const { db, enrolled } = await setup();
		await enrolled(answered());

		expect(
			await unlockKeys(
				db,
				'c1',
				{ ...answered(), credentialId: new Uint8Array([8]).buffer },
				AT
			)
		).toEqual({ status: 'otherWay', unlock: 'device' });
	});

	it('says when the device holds no keys for the source', async () => {
		const { db } = await setup();
		expect(await unlockKeys(db, 'c1', answered(), AT)).toEqual({ status: 'none' });
	});

	it('lets go of the bytes each key is made from, once it is made', async () => {
		const { db, enrolled } = await setup();
		const madeFrom: Uint8Array[] = [];
		const importKey = crypto.subtle.importKey.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((
			...args: Parameters<SubtleCrypto['importKey']>
		) => {
			const [, data] = args;
			if (ArrayBuffer.isView(data)) {
				madeFrom.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			return importKey(...args);
		}) as SubtleCrypto['importKey']);

		await enrolled(answered());
		await unlockKeys(db, 'c1', answered(), AT);
		const entered = await setup();
		await entered.enrolled(PIN);
		await unlockKeys(entered.db, 'c1', PIN, AT);

		expect(madeFrom).toHaveLength(4);
		expect(madeFrom.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it('is what a device can change to and from, the passkey let go of with it', async () => {
		const { db, enrolled } = await setup();
		const keys = await enrolled(PIN);

		const toDevice = await changeUnlock(db, keys, answered(), ROUNDS);
		expect((await db.secretKeys.get('c1'))?.unlock).toBe('device');
		expect(await unlockKeys(db, 'c1', PIN, AT)).toEqual({
			status: 'otherWay',
			unlock: 'device',
		});
		expect(unlocked(await unlockKeys(db, 'c1', answered(), AT)).identities).toHaveLength(2);

		await changeUnlock(db, toDevice as UnlockedKeys, PASSWORD, ROUNDS);
		const record = await db.secretKeys.get('c1');
		expect(record).toMatchObject({ unlock: 'password', rounds: ROUNDS });
		expect(record?.credentialId).toBeUndefined();
		expect(await unlockKeys(db, 'c1', answered(), AT)).toEqual({
			status: 'otherWay',
			unlock: 'password',
		});
	});
});
