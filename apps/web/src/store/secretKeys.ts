import { type NotesDatabase, type SecretKeyRecord, type UnlockKind } from './db.js';

/**
 * A source's keys for secrets on this device (docs/ARCHITECTURE.md §7, "Secrets
 * in a note"), sealed under how the device unlocks: AES-GCM, under a key that
 * PBKDF2-SHA-256 makes from the unlock at 600,000 rounds with a salt of the
 * device's own, all WebCrypto. Nothing about the unlock leaves the device.
 *
 * The identities are 32 bytes each, the source's own first. Nothing here knows
 * what they are for: what checks them against the key file and opens secrets
 * with them is loaded only when a secret is, and needs the curve.
 */

/** A pattern is dots of a 3×3 grid, 0 to 8, in the order they were drawn. */
export type Unlock =
	| Readonly<{ kind: 'pattern'; dots: readonly number[] }>
	| Readonly<{ kind: 'pin'; digits: string }>
	| Readonly<{ kind: 'password'; text: string }>;

export const MIN_PATTERN_DOTS = 4;
export const MIN_PIN_DIGITS = 4;
export const MIN_PASSWORD_CHARACTERS = 8;

/** OWASP's figure for PBKDF2-HMAC-SHA-256 in 2023, which is still its figure. */
export const PBKDF2_ROUNDS = 600_000;

/** Tries a wrong unlock may have without waiting. */
export const FREE_TRIES = 5;
/** How long each try after those waits after the one before. */
export const TRY_WAIT_MS = 30_000;
/** Wrong tries in a row after which the device's copy is deleted. */
export const MAX_TRIES = 10;

const IDENTITY_SIZE = 32;
const SALT_SIZE = 16;
const IV_SIZE = 12;
const GRID_DOTS = 9;

/**
 * A source's keys while this tab holds them unlocked: what a secret is opened
 * with, and the key they are sealed under, so that one more can be sealed in
 * with them without asking for the unlock again. Filled with zeros and let go
 * when the device locks (`secrets/lock.ts`).
 */
export interface UnlockedKeys {
	readonly connectionId: string;
	readonly recipient: string;
	readonly identities: readonly Uint8Array[];
	readonly sealing: CryptoKey;
	/** The nonce of the sealing they were opened from, which says whether it is still the one stored. */
	readonly sealedAs: ArrayBuffer;
}

const isPattern = (dots: readonly number[]): boolean =>
	dots.length >= MIN_PATTERN_DOTS &&
	new Set(dots).size === dots.length &&
	dots.every((dot) => Number.isInteger(dot) && dot >= 0 && dot < GRID_DOTS);

/** Whether a device may be set to unlock this way. */
export const isAcceptedUnlock = (unlock: Unlock): boolean => {
	if (unlock.kind === 'pattern') return isPattern(unlock.dots);
	if (unlock.kind === 'pin') return new RegExp(`^[0-9]{${MIN_PIN_DIGITS},}$`).test(unlock.digits);
	return [...unlock.text].length >= MIN_PASSWORD_CHARACTERS;
};

/**
 * What PBKDF2 is given. The kind is part of it, so a PIN and a pattern that
 * spell the same digits are different unlocks; a password is taken in NFC, so
 * the same characters typed through another keyboard are the same password.
 */
const secretOf = (unlock: Unlock): Uint8Array<ArrayBuffer> => {
	const text = (() => {
		if (unlock.kind === 'pattern') return unlock.dots.join(',');
		if (unlock.kind === 'pin') return unlock.digits;
		return unlock.text.normalize('NFC');
	})();
	return Uint8Array.from(new TextEncoder().encode(`${unlock.kind}:${text}`));
};

const sealingKey = async (
	unlock: Unlock,
	salt: ArrayBuffer,
	rounds: number
): Promise<CryptoKey> => {
	const secret = secretOf(unlock);
	try {
		const material = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, [
			'deriveKey',
		]);
		return await crypto.subtle.deriveKey(
			{ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: rounds },
			material,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt']
		);
	} finally {
		secret.fill(0);
	}
};

// WebCrypto is handed views, never bare buffers, which are kept for IndexedDB:
// a browser takes either, but Node's WebCrypto under jsdom, where the tests
// run, refuses a buffer.
const randomBuffer = (size: number): ArrayBuffer =>
	crypto.getRandomValues(new Uint8Array(size)).buffer;

/** The identities sealed under `key`, with a nonce of their own. */
const seal = async (
	key: CryptoKey,
	identities: readonly Uint8Array[]
): Promise<Pick<SecretKeyRecord, 'iv' | 'sealed'>> => {
	const plain = new Uint8Array(identities.length * IDENTITY_SIZE);
	identities.forEach((identity, at) => {
		plain.set(identity, at * IDENTITY_SIZE);
	});
	const iv = randomBuffer(IV_SIZE);
	try {
		return {
			iv,
			sealed: await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: new Uint8Array(iv) },
				key,
				plain
			),
		};
	} finally {
		plain.fill(0);
	}
};

/** The identities a record seals, or nothing where `key` is not the one it was sealed under. */
const open = async (
	key: CryptoKey,
	record: Pick<SecretKeyRecord, 'iv' | 'sealed'>
): Promise<Uint8Array[] | undefined> => {
	const plain = await crypto.subtle
		.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(record.iv) },
			key,
			new Uint8Array(record.sealed)
		)
		.then(
			(bytes) => new Uint8Array(bytes),
			() => undefined
		);
	if (plain === undefined) return undefined;
	const count = plain.length / IDENTITY_SIZE;
	const identities = Number.isInteger(count)
		? Array.from({ length: count }, (_, at) =>
				plain.slice(at * IDENTITY_SIZE, (at + 1) * IDENTITY_SIZE)
			)
		: undefined;
	plain.fill(0);
	return identities;
};

const sameBytes = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	return left.length === right.length && left.every((byte, at) => byte === right[at]);
};

const copied = (identities: readonly Uint8Array[]): Uint8Array[] =>
	identities.map((identity) => Uint8Array.from(identity));

/** A record's keys sealed under a new unlock, with a salt and a key of their own. */
const sealedUnder = async (
	unlock: Unlock,
	identities: readonly Uint8Array[],
	rounds: number
): Promise<{ sealing: CryptoKey; fields: Omit<SecretKeyRecord, 'connectionId' | 'recipient'> }> => {
	if (!isAcceptedUnlock(unlock)) throw new Error('an unlock this short is not accepted');
	if (identities.length === 0) throw new Error('there is no key to keep');
	const salt = randomBuffer(SALT_SIZE);
	const sealing = await sealingKey(unlock, salt, rounds);
	const { iv, sealed } = await seal(sealing, identities);
	return { sealing, fields: { unlock: unlock.kind, salt, rounds, iv, sealed, tries: 0 } };
};

export interface EnrolInput {
	connectionId: string;
	/** The recipient of the first identity, checked against the key file by the caller. */
	recipient: string;
	/** The source's own first. */
	identities: readonly Uint8Array[];
	unlock: Unlock;
	/** For tests: PBKDF2 at its full count takes most of a second. */
	rounds?: number;
}

/**
 * Keep a source's keys on this device, sealed under `unlock`, replacing any it
 * held. The device is unlocked for the source with them from here. Nothing,
 * where the source has left the device meanwhile.
 */
export const enrol = async (
	db: NotesDatabase,
	input: EnrolInput
): Promise<UnlockedKeys | undefined> => {
	const { connectionId, recipient } = input;
	const { sealing, fields } = await sealedUnder(
		input.unlock,
		input.identities,
		input.rounds ?? PBKDF2_ROUNDS
	);
	// After the derivation, which is not IndexedDB's and would end the
	// transaction it was awaited in.
	const kept = await db.transaction('rw', [db.syncState, db.secretKeys], async () => {
		if ((await db.syncState.get(connectionId)) === undefined) return false;
		await db.secretKeys.put({ connectionId, recipient, ...fields });
		return true;
	});
	if (!kept) return undefined;
	return {
		connectionId,
		recipient,
		identities: copied(input.identities),
		sealing,
		sealedAs: fields.iv,
	};
};

export type UnlockResult =
	| Readonly<{ status: 'unlocked'; keys: UnlockedKeys }>
	/** `waitUntil` where the next try has to wait. */
	| Readonly<{ status: 'wrong'; triesLeft: number; waitUntil?: number }>
	/** Too soon after the last wrong try: nothing was tried. */
	| Readonly<{ status: 'wait'; until: number }>
	/** That was the last wrong try: the device's copy is deleted, and the recovery key is what is left. */
	| Readonly<{ status: 'forgotten' }>
	/** The device holds no keys for the source. */
	| Readonly<{ status: 'none' }>;

/** When a record's next try may be made, where it has to wait. */
export const nextTryAt = (record: SecretKeyRecord): number | undefined =>
	record.tries >= FREE_TRIES && record.triedAt !== undefined
		? record.triedAt + TRY_WAIT_MS
		: undefined;

/**
 * A wrong try, already counted: the record let go of if it was the last, and
 * otherwise how many are left and how long the next waits.
 */
const wrongTry = async (db: NotesDatabase, counted: SecretKeyRecord): Promise<UnlockResult> => {
	if (counted.tries < MAX_TRIES) {
		const until = nextTryAt(counted);
		return {
			status: 'wrong',
			triesLeft: MAX_TRIES - counted.tries,
			...(until === undefined ? {} : { waitUntil: until }),
		};
	}
	await db.transaction('rw', db.secretKeys, async () => {
		const now = await db.secretKeys.get(counted.connectionId);
		if (now !== undefined && sameBytes(now.iv, counted.iv)) {
			await db.secretKeys.delete(counted.connectionId);
		}
	});
	return { status: 'forgotten' };
};

/**
 * Unlock a source's keys on this device. Each try is counted before it is
 * checked, so tries made at once are all counted, and one cut short by the tab
 * closing still is; a right one sets the count back to nothing.
 */
export const unlockKeys = async (
	db: NotesDatabase,
	connectionId: string,
	unlock: Unlock,
	now: number = Date.now()
): Promise<UnlockResult> => {
	const counted = await db.transaction('rw', db.secretKeys, async () => {
		const record = await db.secretKeys.get(connectionId);
		if (record === undefined) return { status: 'none' } as const;
		const until = nextTryAt(record);
		if (until !== undefined && now < until) return { status: 'wait', until } as const;
		const next: SecretKeyRecord = { ...record, tries: record.tries + 1, triedAt: now };
		await db.secretKeys.put(next);
		return { status: 'counted', record: next } as const;
	});
	if (counted.status !== 'counted') return counted;
	const { record } = counted;
	// Wrong without the derivation, which would only come to the same.
	if (record.unlock !== unlock.kind) return wrongTry(db, record);
	const sealing = await sealingKey(unlock, record.salt, record.rounds);
	const identities = await open(sealing, record);
	if (identities === undefined || identities.length === 0) return wrongTry(db, record);
	await db.transaction('rw', db.secretKeys, async () => {
		const stored = await db.secretKeys.get(connectionId);
		if (stored === undefined || !sameBytes(stored.iv, record.iv)) return;
		const { triedAt: _triedAt, ...rest } = stored;
		await db.secretKeys.put({ ...rest, tries: 0 });
	});
	return {
		status: 'unlocked',
		keys: {
			connectionId,
			recipient: record.recipient,
			identities,
			sealing,
			sealedAs: record.iv,
		},
	};
};

/**
 * Seal an unlocked source's keys under a new unlock instead. It asks for no
 * recovery key: an unlocked device already holds the keys (docs/ARCHITECTURE.md
 * §7). Nothing, where the stored keys changed since these were opened, in
 * another tab: sealing these would let go of what that tab sealed in.
 */
export const changeUnlock = async (
	db: NotesDatabase,
	keys: UnlockedKeys,
	unlock: Unlock,
	rounds: number = PBKDF2_ROUNDS
): Promise<UnlockedKeys | undefined> => {
	const { sealing, fields } = await sealedUnder(unlock, keys.identities, rounds);
	const changed = await db.transaction('rw', db.secretKeys, async () => {
		const stored = await db.secretKeys.get(keys.connectionId);
		if (stored === undefined || !sameBytes(stored.iv, keys.sealedAs)) return false;
		await db.secretKeys.put({
			connectionId: stored.connectionId,
			recipient: stored.recipient,
			...fields,
		});
		return true;
	});
	return changed ? { ...keys, sealing, sealedAs: fields.iv } : undefined;
};

/** Let go of a source's keys on this device. */
export const forgetKeys = (db: NotesDatabase, connectionId: string): Promise<void> =>
	db.secretKeys.delete(connectionId);

/** What `UnlockKind` a stored record unlocks with, and its recipient, without unlocking. */
export const enrolment = (
	db: NotesDatabase,
	connectionId: string
): Promise<Pick<SecretKeyRecord, 'recipient' | 'unlock' | 'tries' | 'triedAt'> | undefined> =>
	db.secretKeys.get(connectionId).then((record) => {
		if (record === undefined) return undefined;
		const { recipient, unlock, tries, triedAt } = record;
		return { recipient, unlock, tries, ...(triedAt === undefined ? {} : { triedAt }) };
	});

/** For a test's sake: the kinds an unlock may be. */
export const UNLOCK_KINDS: readonly UnlockKind[] = ['pattern', 'pin', 'password'];
