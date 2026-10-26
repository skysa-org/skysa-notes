import { type NotesDatabase, type SecretKeyRecord, type UnlockKind } from './db.js';

/**
 * A source's keys for secrets on this device (docs/ARCHITECTURE.md §7, "Secrets
 * in a note"), sealed under how the device unlocks: AES-GCM, under a key that
 * PBKDF2-SHA-256 makes from the unlock at 600,000 rounds with a salt of the
 * device's own; or, for the device's own lock, that HKDF-SHA-256 makes from
 * what its passkey answers (`secrets/deviceLock.ts`). All WebCrypto. Nothing
 * about the unlock leaves the device.
 *
 * The identities are 32 bytes each, the source's own first. Nothing here knows
 * what they are for: what checks them against the key file and opens secrets
 * with them is loaded only when a secret is, and needs the curve.
 */

/** What is entered on the device. A pattern is dots of a 3×3 grid, 0 to 8, in the order they were drawn. */
export type EnteredUnlock =
	| Readonly<{ kind: 'pattern'; dots: readonly number[] }>
	| Readonly<{ kind: 'pin'; digits: string }>
	| Readonly<{ kind: 'password'; text: string }>;

/**
 * The device's own lock (`secrets/deviceLock.ts`): the passkey, the salt it
 * is asked, and the 32 bytes it answered after the device's check.
 */
export type DeviceUnlock = Readonly<{
	kind: 'device';
	credentialId: ArrayBuffer;
	salt: ArrayBuffer;
	answer: Uint8Array;
}>;

export type Unlock = EnteredUnlock | DeviceUnlock;

export type EnteredKind = EnteredUnlock['kind'];

const MIN_PATTERN_DOTS = 4;
const MIN_PIN_DIGITS = 4;
const MIN_PASSWORD_CHARACTERS = 8;

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
/** What the device's lock answers with. */
const ANSWER_SIZE = 32;
/** HKDF's `info` for the device's lock: the key it makes is for this and nothing else. */
const DEVICE_INFO = new TextEncoder().encode('secrets: the device lock seals the keys, v1');
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
	if (unlock.kind === 'device')
		return unlock.answer.length === ANSWER_SIZE && unlock.credentialId.byteLength > 0;
	if (unlock.kind === 'pattern') return isPattern(unlock.dots);
	if (unlock.kind === 'pin') return new RegExp(`^[0-9]{${MIN_PIN_DIGITS},}$`).test(unlock.digits);
	return [...unlock.text].length >= MIN_PASSWORD_CHARACTERS;
};

/**
 * What PBKDF2 is given. The kind is part of it, so a PIN and a pattern that
 * spell the same digits are different unlocks; a password is taken in NFC, so
 * the same characters typed through another keyboard are the same password.
 */
const secretOf = (unlock: EnteredUnlock): Uint8Array<ArrayBuffer> => {
	const text = (() => {
		if (unlock.kind === 'pattern') return unlock.dots.join(',');
		if (unlock.kind === 'pin') return unlock.digits;
		return unlock.text.normalize('NFC');
	})();
	return Uint8Array.from(new TextEncoder().encode(`${unlock.kind}:${text}`));
};

/** What the device's lock answered, made a key by HKDF-SHA-256 with the salt its passkey was asked. */
const answeredKey = async (answer: Uint8Array, salt: ArrayBuffer): Promise<CryptoKey> => {
	const secret = Uint8Array.from(answer);
	try {
		const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
		return await crypto.subtle.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: DEVICE_INFO },
			material,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt']
		);
	} finally {
		secret.fill(0);
	}
};

const sealingKey = async (
	unlock: Unlock,
	salt: ArrayBuffer,
	rounds: number
): Promise<CryptoKey> => {
	if (unlock.kind === 'device') return answeredKey(unlock.answer, salt);
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

/**
 * A key of nothing but zeros: one that was wiped, since no key is made so.
 * Sealed, it would unlock to nothing that opens a secret, while the record
 * looks as good as any.
 */
const isWiped = (identity: Uint8Array): boolean => identity.every((byte) => byte === 0);

/**
 * A record's keys sealed under a new unlock, with a salt and a key of their own.
 *
 * `identities` are the caller's own copies, taken before its first await: the
 * derivation is long enough for the page to be hidden, and the lock then
 * fills the keys it holds with zeros in place.
 */
const sealedUnder = async (
	unlock: Unlock,
	identities: readonly Uint8Array[],
	rounds: number
): Promise<{ sealing: CryptoKey; fields: Omit<SecretKeyRecord, 'connectionId' | 'recipient'> }> => {
	if (!isAcceptedUnlock(unlock)) throw new Error('an unlock this short is not accepted');
	if (identities.length === 0) throw new Error('there is no key to keep');
	if (identities.some(isWiped)) throw new Error('a key that was wiped is not kept');
	// The device's lock is asked its salt before this, as its passkey is made.
	const device = unlock.kind === 'device' ? unlock : undefined;
	const salt = device?.salt ?? randomBuffer(SALT_SIZE);
	const sealing = await sealingKey(unlock, salt, rounds);
	const { iv, sealed } = await seal(sealing, identities);
	return {
		sealing,
		fields: {
			unlock: unlock.kind,
			salt,
			rounds: device === undefined ? rounds : 0,
			iv,
			sealed,
			tries: 0,
			...(device === undefined ? {} : { credentialId: device.credentialId }),
		},
	};
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
	const identities = copied(input.identities);
	const { sealing, fields } = await sealedUnder(
		input.unlock,
		identities,
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
	return { connectionId, recipient, identities, sealing, sealedAs: fields.iv };
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
	| Readonly<{ status: 'none' }>
	/**
	 * The device's own lock answered with what does not open the keys: a
	 * passkey replaced, or a platform that answers otherwise now. The recovery
	 * key is what is left; the copy stays until the device is set up again.
	 */
	| Readonly<{ status: 'changed' }>
	/**
	 * The device unlocks with `unlock` now, changed since it was asked for
	 * another way, in another tab: nothing was tried, or counted.
	 */
	| Readonly<{ status: 'otherWay'; unlock: UnlockKind }>;

/** When a record's next try may be made, where it has to wait. */
const nextTryAt = (record: SecretKeyRecord): number | undefined =>
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
 * Unlock with what the device's own lock answered. Not counted: the device
 * counts its own tries, and an answer that does not open the keys will not
 * open them the next time either.
 */
const unlockByDevice = async (
	db: NotesDatabase,
	connectionId: string,
	unlock: DeviceUnlock
): Promise<UnlockResult> => {
	const record = await db.secretKeys.get(connectionId);
	if (record === undefined) return { status: 'none' };
	if (
		record.unlock !== 'device' ||
		record.credentialId === undefined ||
		!sameBytes(record.credentialId, unlock.credentialId)
	) {
		return { status: 'otherWay', unlock: record.unlock };
	}
	const sealing = await answeredKey(unlock.answer, record.salt);
	const identities = await open(sealing, record);
	if (identities === undefined || identities.length === 0) return { status: 'changed' };
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
 * Unlock a source's keys on this device. Each try at an entered unlock is
 * counted before it is checked, so tries made at once are all counted, and
 * one cut short by the tab closing still is; a right one sets the count back
 * to nothing. A try of another kind than the device's is not counted: what
 * kind it is, is no secret, and one asked for by a form opened before the
 * unlock changed is no guess.
 */
export const unlockKeys = async (
	db: NotesDatabase,
	connectionId: string,
	unlock: Unlock,
	now: number = Date.now()
): Promise<UnlockResult> => {
	if (unlock.kind === 'device') return unlockByDevice(db, connectionId, unlock);
	const counted = await db.transaction('rw', db.secretKeys, async () => {
		const record = await db.secretKeys.get(connectionId);
		if (record === undefined) return { status: 'none' } as const;
		if (record.unlock !== unlock.kind) {
			return { status: 'otherWay', unlock: record.unlock } as const;
		}
		const until = nextTryAt(record);
		if (until !== undefined && now < until) return { status: 'wait', until } as const;
		const next: SecretKeyRecord = { ...record, tries: record.tries + 1, triedAt: now };
		await db.secretKeys.put(next);
		return { status: 'counted', record: next } as const;
	});
	if (counted.status !== 'counted') return counted;
	const { record } = counted;
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
	// Copies, taken before anything is awaited: the keys given are the ones a
	// tab's lock holds, and fills with zeros where the page is hidden meanwhile.
	// Holding these in their place locks the ones given in the same way.
	const identities = copied(keys.identities);
	const { sealing, fields } = await sealedUnder(unlock, identities, rounds);
	const changed = await db.transaction('rw', db.secretKeys, async () => {
		const stored = await db.secretKeys.get(keys.connectionId);
		if (stored === undefined || !sameBytes(stored.iv, keys.sealedAs)) return false;
		await db.secretKeys.put({
			connectionId: stored.connectionId,
			recipient: stored.recipient,
			...(stored.former === undefined ? {} : { former: stored.former }),
			...fields,
		});
		return true;
	});
	return changed ? { ...keys, identities, sealing, sealedAs: fields.iv } : undefined;
};

/**
 * The recipients a source's key had before, once it has `recipient`: the one
 * it has now added, where that is replaced, and `recipient` taken out, where
 * the key goes back to one it had.
 */
const formerFor = (stored: SecretKeyRecord, recipient: string): string[] =>
	[...new Set([...(stored.former ?? []), stored.recipient])].filter((each) => each !== recipient);

/**
 * The keys an unlocked device holds, replaced by `given` for `recipient`, and
 * sealed under the same unlock: the source's key replaced, here or on another
 * device and typed here, with the keys this device held kept beside it so that
 * secrets made with them still open; or one more key kept, with the recipient
 * as it was. A recipient replaced is remembered (`former`). Nothing, where
 * another tab sealed the keys again meanwhile.
 */
export const replaceKeys = async (
	db: NotesDatabase,
	keys: UnlockedKeys,
	recipient: string,
	given: readonly Uint8Array[]
): Promise<UnlockedKeys | undefined> => {
	// Copies, before anything is awaited, as `changeUnlock` takes them.
	const identities = copied(given);
	if (identities.length === 0) throw new Error('there is no key to keep');
	if (identities.some(isWiped)) throw new Error('a key that was wiped is not kept');
	const { iv, sealed } = await seal(keys.sealing, identities);
	const replaced = await db.transaction('rw', db.secretKeys, async () => {
		const stored = await db.secretKeys.get(keys.connectionId);
		if (stored === undefined || !sameBytes(stored.iv, keys.sealedAs)) return false;
		await db.secretKeys.put({
			...stored,
			recipient,
			iv,
			sealed,
			former: formerFor(stored, recipient),
		});
		return true;
	});
	return replaced ? { ...keys, recipient, identities, sealedAs: iv } : undefined;
};

/** Let go of a source's keys on this device. */
export const forgetKeys = (db: NotesDatabase, connectionId: string): Promise<void> =>
	db.secretKeys.delete(connectionId);

/** The passkey a device's own lock answers through, and the salt it is asked. */
interface DevicePasskey {
	readonly credentialId: ArrayBuffer;
	readonly salt: ArrayBuffer;
}

export type Enrolment = Pick<SecretKeyRecord, 'recipient' | 'unlock' | 'tries' | 'triedAt'> & {
	/** Where the device unlocks with its own lock. */
	device?: DevicePasskey;
	/** The recipients the source's key had before (`SecretKeyRecord.former`): none, where it was never replaced here. */
	former: readonly string[];
};

/** What `UnlockKind` a stored record unlocks with, and its recipient, without unlocking. */
export const enrolment = (
	db: NotesDatabase,
	connectionId: string
): Promise<Enrolment | undefined> =>
	db.secretKeys.get(connectionId).then((record) => {
		if (record === undefined) return undefined;
		const { recipient, unlock, tries, triedAt, credentialId, salt, former } = record;
		return {
			recipient,
			unlock,
			tries,
			former: former ?? [],
			...(triedAt === undefined ? {} : { triedAt }),
			...(unlock === 'device' && credentialId !== undefined
				? { device: { credentialId, salt } }
				: {}),
		};
	});
