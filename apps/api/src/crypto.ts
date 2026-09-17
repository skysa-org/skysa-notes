/**
 * AES-256-GCM over the secrets in D1: an OAuth refresh token, or a set of
 * WebDAV credentials. Web Crypto only — the Worker runs without `nodejs_compat`
 * (docs/PLAN.md §6) — and the key never leaves the server environment.
 *
 * Every sealed value records which key sealed it, so a key can be rotated by
 * re-encrypting rows rather than by invalidating every connection at once.
 */

/** AES-GCM wants 96 bits; longer is allowed but gains nothing and costs space. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SealedSecret {
	ciphertext: string;
	iv: string;
	keyId: string;
}

export interface SecretKey {
	id: string;
	key: CryptoKey;
}

const toBase64 = (bytes: Uint8Array): string =>
	btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));

/**
 * Accepts base64 and base64url alike, padded or not. `env.ts` normalizes the
 * same way before checking `SECRETS_KEY`'s length, and the two had better agree:
 * a key this rejects but the validator accepts is a deployment that passes its
 * boot check and then fails every request.
 */
const fromBase64 = (value: string): Uint8Array => {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	// `atob` rejects a length that is not a multiple of four, and base64url
	// drops the padding that would have made it one.
	const pad = (4 - (base64.length % 4)) % 4;
	return Uint8Array.from(atob(base64.padEnd(base64.length + pad, '=')), (char) =>
		char.charCodeAt(0)
	);
};

/**
 * `SECRETS_KEY` is base64 of exactly 32 random bytes. A key of the wrong length
 * is an operator mistake worth failing on at boot rather than at first use.
 */
export const importSecretKey = async (base64: string, id: string): Promise<SecretKey> => {
	const raw = fromBase64(base64);
	if (raw.length !== KEY_BYTES) {
		throw new Error(`SECRETS_KEY must decode to ${String(KEY_BYTES)} bytes`);
	}

	const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
	return { id, key };
};

export const seal = async (secret: SecretKey, plaintext: string): Promise<SealedSecret> => {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		secret.key,
		new TextEncoder().encode(plaintext)
	);

	return {
		ciphertext: toBase64(new Uint8Array(sealed)),
		iv: toBase64(iv),
		keyId: secret.id,
	};
};

export const open = async (secret: SecretKey, sealed: SealedSecret): Promise<string> => {
	// A clear error beats the opaque failure AES-GCM would give for a row sealed
	// with a key this deployment no longer holds.
	if (sealed.keyId !== secret.id) {
		throw new Error(`no key named ${sealed.keyId} is configured`);
	}

	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(sealed.iv) },
		secret.key,
		fromBase64(sealed.ciphertext)
	);
	return new TextDecoder().decode(plaintext);
};

/** What a Dropbox connection stores. WebDAV, deferred, would add its own shape. */
export interface OAuthSecret {
	refreshToken: string;
}

export const sealOAuthSecret = (secret: SecretKey, value: OAuthSecret): Promise<SealedSecret> =>
	seal(secret, JSON.stringify(value));

export const openOAuthSecret = async (
	secret: SecretKey,
	sealed: SealedSecret
): Promise<OAuthSecret> => JSON.parse(await open(secret, sealed)) as OAuthSecret;

/** URL-safe base64 without padding, which is what OAuth and cookies both want. */
export const toBase64Url = (bytes: Uint8Array): string =>
	toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * base64url in, bytes out. The same decoder as plain base64 — `fromBase64`
 * normalizes both alphabets — but named at the call site so the intent is clear.
 */
export const fromBase64Url = fromBase64;

export const randomBase64Url = (bytes: number): string =>
	toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * HMAC-SHA256, used to sign the short-lived cookie that carries the PKCE
 * verifier between the start of an OAuth flow and its callback.
 *
 * Derived from `SECRETS_KEY` through HKDF rather than importing the same bytes
 * a second time: one key material, two algorithms, is how key-separation bugs
 * start. The label is versioned so a future use can derive its own key without
 * colliding with this one.
 */
const FLOW_COOKIE_INFO = 'skysa:flow-cookie:v1';

export const signingKey = async (base64: string): Promise<CryptoKey> => {
	const material = await crypto.subtle.importKey('raw', fromBase64(base64), 'HKDF', false, [
		'deriveKey',
	]);

	// No salt: the input is already 32 uniformly random bytes, which is exactly
	// the case RFC 5869 §3.1 says a salt is unnecessary for.
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(FLOW_COOKIE_INFO),
		},
		material,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
};

export const sign = async (key: CryptoKey, value: string): Promise<string> =>
	toBase64Url(
		new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
	);

/**
 * Constant-time by construction: `crypto.subtle.verify` does not short-circuit
 * on the first differing byte.
 *
 * A signature that is not base64 at all makes `atob` *throw* where a merely
 * wrong one returns false, and the difference matters: the caller reads a
 * cookie an attacker may have written, and an exception there is a 500 and a
 * poisoned cookie that never gets cleared. Every malformed signature is just an
 * invalid one.
 */
export const verify = async (
	key: CryptoKey,
	value: string,
	signature: string
): Promise<boolean> => {
	// Only the decode is guarded: a failure inside `crypto.subtle.verify` itself
	// would be a bug worth seeing, not a signature to reject quietly.
	const decoded = ((): Uint8Array | undefined => {
		try {
			return fromBase64(signature);
		} catch {
			return undefined;
		}
	})();
	if (decoded === undefined) return false;

	return crypto.subtle.verify('HMAC', key, decoded, new TextEncoder().encode(value));
};
