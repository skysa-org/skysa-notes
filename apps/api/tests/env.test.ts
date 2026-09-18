import { describe, expect, it } from 'vitest';

import { importSecretKey, signingKey } from '../src/crypto.js';
import { parseEnv } from '../src/env.js';

const base = {
	APP_ORIGIN: 'https://notes.example.com',
	// Exactly 32 bytes once decoded, which `parseEnv` insists on.
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
};

describe('parseEnv', () => {
	/**
	 * The default names only what is implemented. Defaulting to all four would
	 * make a deployment that set no `ENABLED_PROVIDERS` refuse to boot until its
	 * operator had registered apps with Google *and* Microsoft, for flows that
	 * do not exist yet.
	 */
	it('defaults to storage-first with the one implemented provider', () => {
		const config = parseEnv({
			...base,
			DROPBOX_CLIENT_ID: 'd',
			DROPBOX_CLIENT_SECRET: 'ds',
		});
		expect(config.authMode).toBe('storage-first');
		expect(config.enabledProviders).toEqual(['dropbox']);
		expect(config.secretsKeyId).toBe('k1');
		expect(config.webdavAllowPrivate).toBe(false);
	});

	it('parses ENABLED_PROVIDERS and ignores whitespace', () => {
		const config = parseEnv({
			...base,
			ENABLED_PROVIDERS: ' webdav , dropbox ',
			DROPBOX_CLIENT_ID: 'd',
			DROPBOX_CLIENT_SECRET: 'ds',
		});
		expect(config.enabledProviders).toEqual(['webdav', 'dropbox']);
	});

	it('only builds OAuth credentials for enabled providers', () => {
		const config = parseEnv({
			...base,
			ENABLED_PROVIDERS: 'dropbox',
			DROPBOX_CLIENT_ID: 'd',
			DROPBOX_CLIENT_SECRET: 'ds',
			// Present but unused: gdrive is not enabled.
			GOOGLE_CLIENT_ID: 'g',
			GOOGLE_CLIENT_SECRET: 'gs',
		});
		expect(config.oauth.dropbox).toEqual({ clientId: 'd', clientSecret: 'ds' });
		expect(config.oauth.gdrive).toBeUndefined();
	});

	it('requires credentials for each enabled OAuth provider', () => {
		expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: 'gdrive' })).toThrow(
			/GOOGLE_CLIENT_ID: required because ENABLED_PROVIDERS includes "gdrive"/
		);
	});

	it('needs no credentials for a webdav-only instance', () => {
		const config = parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav' });
		expect(config.oauth).toEqual({});
	});

	it('rejects an unknown provider', () => {
		expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: 'icloud' })).toThrow(
			/ENABLED_PROVIDERS/
		);
	});

	it('rejects an empty provider list', () => {
		expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: '' })).toThrow(/at least one provider/);
	});

	it('refuses to boot in account-first, which is not built and will not be', () => {
		// It used to be accepted and then behave exactly like storage-first, which
		// is the worst of the three possibilities: an operator who set it believed
		// connections were gated behind a sign-in they had configured, and they
		// were not. Configuring a sign-in provider does not make it true either.
		//
		// Since 2026-09-18 the refusal is permanent rather than an interim: there
		// is no sign-in layer coming (docs/PLAN.md §6). The variable outlives the
		// decision only until the `users`/`identities` tables are dropped.
		for (const extra of [
			{},
			{ MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 'ms' },
			{ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs' },
		]) {
			expect(() =>
				parseEnv({
					...base,
					AUTH_MODE: 'account-first',
					ENABLED_PROVIDERS: 'webdav',
					...extra,
				})
			).toThrow(/account-first is not implemented and will not be/);
		}
	});

	it('reads WEBDAV_ALLOW_PRIVATE as a string flag', () => {
		expect(
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', WEBDAV_ALLOW_PRIVATE: 'true' })
				.webdavAllowPrivate
		).toBe(true);
		expect(
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', WEBDAV_ALLOW_PRIVATE: 'false' })
				.webdavAllowPrivate
		).toBe(false);
	});

	it('rejects a missing or malformed APP_ORIGIN', () => {
		expect(() => parseEnv({ SECRETS_KEY: 'x', ENABLED_PROVIDERS: 'webdav' })).toThrow(
			/APP_ORIGIN/
		);
		expect(() =>
			parseEnv({ ...base, APP_ORIGIN: 'notaurl', ENABLED_PROVIDERS: 'webdav' })
		).toThrow(/APP_ORIGIN/);
	});

	it('strips a trailing slash from APP_ORIGIN so redirect URIs concatenate cleanly', () => {
		const config = parseEnv({
			...base,
			APP_ORIGIN: 'https://notes.example.com/',
			ENABLED_PROVIDERS: 'webdav',
		});
		expect(config.appOrigin).toBe('https://notes.example.com');
	});

	it('lists every problem at once', () => {
		try {
			parseEnv({ ENABLED_PROVIDERS: 'gdrive' });
			expect.unreachable('should have thrown');
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain('APP_ORIGIN');
			expect(message).toContain('SECRETS_KEY');
			expect(message).toContain('GOOGLE_CLIENT_ID');
		}
	});
});

describe('SECRETS_KEY', () => {
	it('insists on exactly 32 bytes, at boot rather than at first use', () => {
		// AES-256 needs a 256-bit key. A short one would otherwise be accepted
		// here and fail the first time somebody tried to connect an account.
		const short = btoa('0123456789abcdef');

		expect(() =>
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', SECRETS_KEY: short })
		).toThrow(/32 bytes/);
	});

	it('rejects a value that is not base64 at all', () => {
		expect(() =>
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', SECRETS_KEY: 'not base64!!' })
		).toThrow(/32 bytes/);
	});

	it('accepts a key generated the way the docs say to generate one', () => {
		// `openssl rand -base64 32` — standard alphabet, padded.
		const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

		expect(() =>
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', SECRETS_KEY: key })
		).not.toThrow();
	});
});

describe('cookiesSecure', () => {
	it('is on for an https origin', () => {
		expect(
			parseEnv({
				...base,
				ENABLED_PROVIDERS: 'webdav',
				APP_ORIGIN: 'https://notes.example.com',
			}).cookiesSecure
		).toBe(true);
	});

	it('is off for plain-http local development, where a secure cookie is never sent', () => {
		expect(
			parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', APP_ORIGIN: 'http://localhost:5173' })
				.cookiesSecure
		).toBe(false);
	});
});

describe('what the first draft got wrong', () => {
	it('accepts exactly the keys the crypto module can import', async () => {
		// The validator normalized `-`/`_` before measuring; the decoder did not.
		// A base64url key therefore passed the boot check and then failed on every
		// request, as a 500 from `/api/health` rather than as misconfiguration.
		const key = '-wIJEBceJSwzOkFIT1ZdZGtyeYCHjpWco6qxuL_GzdQ=';
		const config = parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', SECRETS_KEY: key });

		await expect(importSecretKey(config.secretsKey, 'k1')).resolves.toBeDefined();
		await expect(signingKey(config.secretsKey)).resolves.toBeDefined();
	});
});
