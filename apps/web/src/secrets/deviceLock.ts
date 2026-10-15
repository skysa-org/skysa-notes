import { t } from '../i18n/t.js';
import { toBase64Url } from '../store/credentials.js';
import type { DeviceUnlock } from '../store/secretKeys.js';

/**
 * This device's own lock, as what its copy of a source's keys is sealed under
 * (docs/ARCHITECTURE.md §7, "The device's own lock, where there is one"). A
 * passkey made on this device answers a salt, through WebAuthn's PRF
 * extension, with the same 32 bytes each time, and only after the device's
 * own check: a fingerprint, a face or the device's PIN, as the browser
 * chooses. The hardware counts the tries.
 *
 * The passkey is a key, not a sign-in. It is made and used in the browser
 * alone, never registered with the API, and nothing it signs is checked:
 * what it answers either opens the keys or does not.
 *
 * https://w3c.github.io/webauthn/#prf-extension
 * https://w3c.github.io/webauthn/#sctn-getClientCapabilities
 */

export type Made =
	| Readonly<{ state: 'made'; credentialId: ArrayBuffer; answer?: Uint8Array }>
	/** Not made: the user, or the browser, said no. */
	| Readonly<{ state: 'refused' }>
	/**
	 * Made, and it cannot answer a salt: the device's lock cannot keep a key
	 * in this browser. The passkey is named where there is one to let go of.
	 */
	| Readonly<{ state: 'unsupported'; credentialId?: ArrayBuffer }>;

/**
 * What the passkey answered a salt: its 32 bytes; `refused` where the user,
 * or the browser, said no; `unsupported` where it answered and gave no
 * answer to the salt, which it cannot give.
 */
export type Answer = Uint8Array | 'refused' | 'unsupported';

export interface DeviceLock {
	/**
	 * Whether to offer it: where the browser has a lock of the device's own
	 * to ask and does not say it cannot answer a salt. Making the passkey
	 * settles what it does not say.
	 */
	readonly offered: () => Promise<boolean>;
	/** A passkey for unlocking, named `name`, with what it answered `salt` as it was made, if it did. */
	readonly create: (salt: Uint8Array<ArrayBuffer>, name: string) => Promise<Made>;
	/** What the passkey answers `salt`, after the device's own check. */
	readonly answer: (credentialId: ArrayBuffer, salt: Uint8Array<ArrayBuffer>) => Promise<Answer>;
	/**
	 * A passkey the app has let go of, said to be unknown so the password
	 * manager listing it can take it out, where the browser lets that be
	 * said: one left listed looks like one that still unlocks.
	 */
	readonly forget: (credentialId: ArrayBuffer) => Promise<void>;
}

/** How many bytes the extension answers with. */
const ANSWER_SIZE = 32;
const SALT_SIZE = 32;

/**
 * How long the device is asked, at most. The page does not lock while it
 * asks (`SecretsLock.prompting`), so the browser's own few minutes would
 * leave it open that long.
 */
const ASKED_MS = 60_000;

const random = (size: number): Uint8Array<ArrayBuffer> =>
	crypto.getRandomValues(new Uint8Array(size));

/**
 * A copy of what the extension answered. The browser's own bytes are filled
 * with zeros once copied, as they would stay in the credential it gave.
 */
const answerOf = (credential: Credential | null): Answer => {
	if (credential === null || !('getClientExtensionResults' in credential)) return 'refused';
	const first = (credential as PublicKeyCredential).getClientExtensionResults().prf?.results
		?.first;
	if (first === undefined) return 'unsupported';
	const bytes = ArrayBuffer.isView(first)
		? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
		: new Uint8Array(first);
	const answer = bytes.length === ANSWER_SIZE ? Uint8Array.from(bytes) : 'unsupported';
	bytes.fill(0);
	return answer;
};

/**
 * What the browser says of the extension and of a lock of the device's own,
 * each where it says. One that cannot say is asked whether there is a lock,
 * and making the passkey says whether it answers.
 */
const capabilities = async (): Promise<{ prf?: boolean; platform?: boolean }> => {
	if (typeof PublicKeyCredential.getClientCapabilities !== 'function') return {};
	const said = await PublicKeyCredential.getClientCapabilities();
	// A key it leaves out is one it does not say: Safari says only what its
	// platform tells it.
	const prf = said['extension:prf'];
	return {
		...(prf === undefined ? {} : { prf }),
		...(said.userVerifyingPlatformAuthenticator === undefined
			? {}
			: { platform: said.userVerifyingPlatformAuthenticator }),
	};
};

/** The device's own lock, as the browser offers it. */
export const browserDeviceLock = (): DeviceLock => ({
	offered: async () => {
		if (typeof PublicKeyCredential === 'undefined') return false;
		try {
			const { prf, platform } = await capabilities();
			if (prf === false) return false;
			return (
				platform ??
				(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
			);
		} catch {
			return false;
		}
	},
	create: async (salt, name) => {
		const made = await navigator.credentials
			.create({
				publicKey: {
					rp: { name: import.meta.env.VITE_APP_NAME ?? t('install.thisApp') },
					user: { id: random(16), name, displayName: name },
					challenge: random(32),
					// ES256, then RS256 for Windows Hello.
					pubKeyCredParams: [
						{ type: 'public-key', alg: -7 },
						{ type: 'public-key', alg: -257 },
					],
					authenticatorSelection: {
						authenticatorAttachment: 'platform',
						userVerification: 'required',
						residentKey: 'preferred',
					},
					attestation: 'none',
					timeout: ASKED_MS,
					extensions: { prf: { eval: { first: salt } } },
				},
			})
			.catch(() => null);
		if (made === null || !('rawId' in made)) return { state: 'refused' };
		const credential = made as PublicKeyCredential;
		if (credential.getClientExtensionResults().prf?.enabled !== true) {
			return { state: 'unsupported', credentialId: credential.rawId };
		}
		// Some answer as the passkey is made, and some only once it is asked.
		const answer = answerOf(credential);
		return {
			state: 'made',
			credentialId: credential.rawId,
			...(typeof answer === 'string' ? {} : { answer }),
		};
	},
	answer: async (credentialId, salt) => {
		const got = await navigator.credentials
			.get({
				publicKey: {
					challenge: random(32),
					allowCredentials: [
						{ type: 'public-key', id: credentialId, transports: ['internal'] },
					],
					userVerification: 'required',
					timeout: ASKED_MS,
					extensions: { prf: { eval: { first: salt } } },
				},
			})
			.catch(() => null);
		return answerOf(got);
	},
	// https://w3c.github.io/webauthn/#sctn-signal-methods
	forget: async (credentialId) => {
		if (
			typeof PublicKeyCredential === 'undefined' ||
			typeof PublicKeyCredential.signalUnknownCredential !== 'function'
		) {
			return;
		}
		await PublicKeyCredential.signalUnknownCredential({
			// The page's own, as the passkey was made naming none.
			rpId: location.hostname,
			credentialId: toBase64Url(new Uint8Array(credentialId)),
		}).catch(() => undefined);
	},
});

export const BROWSER_DEVICE_LOCK: DeviceLock = browserDeviceLock();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);

export type DeviceSetUp =
	| Readonly<{ state: 'set'; unlock: DeviceUnlock }>
	| Readonly<{ state: 'refused' | 'unsupported' }>;

/**
 * Whether the passkey `made` answers `salt` the same each time: what it
 * answered as it was made and once after, or, where making it answered
 * nothing, twice after. The keys are sealed under the second answer.
 */
const checked = async (
	lock: DeviceLock,
	made: Extract<Made, { state: 'made' }>,
	salt: Uint8Array<ArrayBuffer>
): Promise<DeviceSetUp> => {
	const first = made.answer ?? (await lock.answer(made.credentialId, salt));
	if (typeof first === 'string') return { state: first };
	try {
		const second = await lock.answer(made.credentialId, salt);
		if (typeof second === 'string') return { state: second };
		if (!sameBytes(first, second)) {
			second.fill(0);
			return { state: 'unsupported' };
		}
		return {
			state: 'set',
			unlock: {
				kind: 'device',
				credentialId: made.credentialId,
				salt: salt.buffer,
				answer: second,
			},
		};
	} finally {
		first.fill(0);
	}
};

/**
 * A passkey made to unlock with, and one unlock with it, which proves it
 * answers the same each time: a passkey that answers otherwise would seal
 * the keys under bytes it never gives again. One made and not kept is let
 * go of (`forget`).
 */
export const setUpDeviceLock = async (lock: DeviceLock, name: string): Promise<DeviceSetUp> => {
	const salt = random(SALT_SIZE);
	const made = await lock.create(salt, name);
	if (made.state === 'refused') return made;
	if (made.state === 'unsupported') {
		if (made.credentialId !== undefined) void lock.forget(made.credentialId);
		return { state: 'unsupported' };
	}
	const set = await checked(lock, made, salt);
	if (set.state !== 'set') void lock.forget(made.credentialId);
	return set;
};
