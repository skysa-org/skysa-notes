import { t } from '../i18n/t.js';
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
	/** Made, and it cannot answer a salt: the device's lock cannot keep a key in this browser. */
	| Readonly<{ state: 'unsupported' }>;

export interface DeviceLock {
	/**
	 * Whether to offer it: where the browser says it can answer a salt, or
	 * cannot say but has a lock of the device's own to ask, which making the
	 * passkey then settles.
	 */
	readonly offered: () => Promise<boolean>;
	/** A passkey for unlocking, named `name`, with what it answered `salt` as it was made, if it did. */
	readonly create: (salt: Uint8Array<ArrayBuffer>, name: string) => Promise<Made>;
	/** What the passkey answers `salt`, after the device's own check; nothing where it did not. */
	readonly answer: (
		credentialId: ArrayBuffer,
		salt: Uint8Array<ArrayBuffer>
	) => Promise<Uint8Array | undefined>;
}

/** How many bytes the extension answers with. */
const ANSWER_SIZE = 32;
const SALT_SIZE = 32;

const random = (size: number): Uint8Array<ArrayBuffer> =>
	crypto.getRandomValues(new Uint8Array(size));

/** A copy of what the extension answered, if it is an answer. */
const answerOf = (credential: Credential | null): Uint8Array | undefined => {
	if (credential === null || !('getClientExtensionResults' in credential)) return undefined;
	const first = (credential as PublicKeyCredential).getClientExtensionResults().prf?.results
		?.first;
	if (first === undefined) return undefined;
	const bytes = ArrayBuffer.isView(first)
		? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
		: new Uint8Array(first);
	return bytes.length === ANSWER_SIZE ? Uint8Array.from(bytes) : undefined;
};

/**
 * What the browser says of the extension and of a lock of the device's own,
 * each where it says. One that cannot say is asked whether there is a lock,
 * and making the passkey says whether it answers.
 */
const capabilities = async (): Promise<{ prf?: boolean; platform?: boolean }> => {
	if (typeof PublicKeyCredential.getClientCapabilities !== 'function') return {};
	const said = await PublicKeyCredential.getClientCapabilities();
	return {
		prf: said['extension:prf'] ?? false,
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
					extensions: { prf: { eval: { first: salt } } },
				},
			})
			.catch(() => null);
		if (made === null || !('rawId' in made)) return { state: 'refused' };
		const credential = made as PublicKeyCredential;
		if (credential.getClientExtensionResults().prf?.enabled !== true) {
			return { state: 'unsupported' };
		}
		const answer = answerOf(credential);
		return {
			state: 'made',
			credentialId: credential.rawId,
			...(answer === undefined ? {} : { answer }),
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
					extensions: { prf: { eval: { first: salt } } },
				},
			})
			.catch(() => null);
		return answerOf(got);
	},
});

export const BROWSER_DEVICE_LOCK: DeviceLock = browserDeviceLock();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);

export type DeviceSetUp =
	| Readonly<{ state: 'set'; unlock: DeviceUnlock }>
	| Readonly<{ state: 'refused' | 'unsupported' }>;

/**
 * A passkey made to unlock with, and one unlock with it, which proves it
 * answers the same each time: what it answered as it was made and once after,
 * or, where making it answered nothing, twice after. A passkey that answers
 * otherwise would seal the keys under bytes it never gives again.
 */
export const setUpDeviceLock = async (lock: DeviceLock, name: string): Promise<DeviceSetUp> => {
	const salt = random(SALT_SIZE);
	const made = await lock.create(salt, name);
	if (made.state !== 'made') return made;
	const first = made.answer ?? (await lock.answer(made.credentialId, salt));
	if (first === undefined) return { state: 'refused' };
	const second = await lock.answer(made.credentialId, salt);
	try {
		if (second === undefined) return { state: 'refused' };
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
