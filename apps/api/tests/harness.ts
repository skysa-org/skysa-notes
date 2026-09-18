import { createApp, type CreateAppOptions } from '../src/app.js';
import { CREDENTIAL_PREFIX, hashCredential } from '../src/credentials.js';
import {
	fromBase64Url,
	importSecretKey,
	openOAuthSecret,
	randomBase64Url,
	toBase64Url,
} from '../src/crypto.js';
import { type AppConfig, parseEnv } from '../src/env.js';
import { flowCookieName } from '../src/session.js';
import { createD1 } from './d1.js';

/**
 * One app, one in-memory database, one scripted Dropbox. Every test builds its
 * own so nothing leaks between them.
 */

export const SECRETS_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

/**
 * The secret a connection row holds, opened. `gdrive.test.ts` and
 * `onedrive.test.ts` each had their own copy of this, and `connect.test.ts`
 * and `token.test.ts` open a row inline in three more places; a caller that
 * needs the plaintext to prove it is *not* in a response is what made one copy
 * worth having.
 */
export const secretOf = async (row: {
	secretCiphertext: string;
	secretIv: string;
	secretKeyId: string;
}) =>
	openOAuthSecret(await importSecretKey(SECRETS_KEY, 'k1'), {
		ciphertext: row.secretCiphertext,
		iv: row.secretIv,
		keyId: row.secretKeyId,
	});

export const testConfig = (
	overrides: Partial<AppConfig> = {},
	env: Record<string, string> = {}
): AppConfig => ({
	...parseEnv({
		APP_ORIGIN: 'https://notes.example.com',
		SECRETS_KEY,
		ENABLED_PROVIDERS: 'dropbox',
		DROPBOX_CLIENT_ID: 'client-id',
		DROPBOX_CLIENT_SECRET: 'client-secret',
		...env,
	}),
	...overrides,
});

export const MICROSOFT_CLIENT_ID = 'ms-client-id';

/** Both OAuth providers enabled and configured. */
export const bothProvidersConfig = (
	overrides: Partial<AppConfig> = {},
	env: Record<string, string> = {}
): AppConfig =>
	testConfig(overrides, {
		ENABLED_PROVIDERS: 'dropbox,onedrive',
		MICROSOFT_CLIENT_ID,
		MICROSOFT_CLIENT_SECRET: 'ms-client-secret',
		...env,
	});

export const GOOGLE_CLIENT_ID = 'google-client-id.apps.googleusercontent.com';

/** Every OAuth provider enabled and configured. */
export const allProvidersConfig = (
	overrides: Partial<AppConfig> = {},
	env: Record<string, string> = {}
): AppConfig =>
	bothProvidersConfig(overrides, {
		ENABLED_PROVIDERS: 'dropbox,onedrive,gdrive',
		GOOGLE_CLIENT_ID,
		GOOGLE_CLIENT_SECRET: 'google-client-secret',
		...env,
	});

/** An ID token as a token endpoint returns one. The signature is never checked. */
export const idToken = (claims: Record<string, unknown>): string => {
	const part = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
	return `${part({ typ: 'JWT', alg: 'RS256' })}.${part(claims)}.c2lnbmF0dXJl`;
};

export const MICROSOFT_ACCOUNT = 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ';

export const microsoftTokenResponse = (
	over: Record<string, unknown> = {},
	claims: Record<string, unknown> = {}
): Response =>
	json({
		token_type: 'Bearer',
		access_token: 'ms-access-1',
		refresh_token: 'ms-refresh-1',
		expires_in: 3600,
		id_token: idToken({
			aud: MICROSOFT_CLIENT_ID,
			sub: MICROSOFT_ACCOUNT,
			tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
			email: 'person@outlook.com',
			...claims,
		}),
		...over,
	});

export const GOOGLE_ACCOUNT = '110169484474386276334';

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const googleTokenResponse = (
	over: Record<string, unknown> = {},
	claims: Record<string, unknown> = {}
): Response =>
	json({
		token_type: 'Bearer',
		access_token: 'google-access-1',
		refresh_token: 'google-refresh-1',
		expires_in: 3599,
		// Google names `email` by its long form in the granted scopes.
		scope: `https://www.googleapis.com/auth/userinfo.email openid ${GOOGLE_DRIVE_SCOPE}`,
		id_token: idToken({
			iss: 'https://accounts.google.com',
			aud: GOOGLE_CLIENT_ID,
			sub: GOOGLE_ACCOUNT,
			email: 'person@gmail.com',
			email_verified: true,
			...claims,
		}),
		...over,
	});

export interface DropboxScript {
	/** Microsoft's token endpoint, which is one URL for the exchange and the refresh. */
	microsoft?: (form: Record<string, string>, url: string) => Response;
	/** Google's token endpoint, one URL for the exchange and the refresh. */
	google?: (form: Record<string, string>) => Response;
	/** Google's revoke endpoint. */
	googleRevoke?: (form: Record<string, string>) => Response;
	/** Code → the token response Dropbox would give for it. */
	exchange?: (code: string, verifier: string) => Response;
	refresh?: (refreshToken: string) => Response;
	account?: () => Response;
	revoke?: () => Response;
}

/** Microsoft's token endpoint, or `undefined` for any other URL. */
const answerMicrosoft = (
	script: DropboxScript,
	url: string,
	form: Record<string, string>,
	account: string
): Response | undefined => {
	if (!url.startsWith('https://login.microsoftonline.com/')) return undefined;
	if (script.microsoft !== undefined) return script.microsoft(form, url);
	// Microsoft rotates the refresh token on every refresh.
	return form.grant_type === 'refresh_token'
		? microsoftTokenResponse({ access_token: 'ms-access-2', refresh_token: 'ms-refresh-2' })
		: microsoftTokenResponse(
				{},
				{ sub: account === DEFAULT_ACCOUNT ? MICROSOFT_ACCOUNT : account }
			);
};

/** Google's two endpoints, or `undefined` for any other URL. */
const answerGoogle = (
	script: DropboxScript,
	url: string,
	form: Record<string, string>,
	account: string
): Response | undefined => {
	if (url === 'https://oauth2.googleapis.com/revoke') {
		return script.googleRevoke?.(form) ?? json({});
	}
	if (url !== 'https://oauth2.googleapis.com/token') return undefined;
	if (script.google !== undefined) return script.google(form);
	// Google sends no new refresh token on a refresh.
	return form.grant_type === 'refresh_token'
		? googleTokenResponse({ access_token: 'google-access-2', refresh_token: undefined })
		: googleTokenResponse({}, { sub: account === DEFAULT_ACCOUNT ? GOOGLE_ACCOUNT : account });
};

const answer = (
	script: DropboxScript,
	url: string,
	form: Record<string, string>,
	account: string
): Response => {
	const microsoft = answerMicrosoft(script, url, form, account);
	if (microsoft !== undefined) return microsoft;
	const google = answerGoogle(script, url, form, account);
	if (google !== undefined) return google;
	if (url.endsWith('/oauth2/token')) {
		if (form.grant_type === 'refresh_token') {
			// Dropbox normally returns no new refresh token on a refresh.
			return (
				script.refresh?.(form.refresh_token ?? '') ??
				tokenResponse({ refresh_token: undefined })
			);
		}
		return (
			script.exchange?.(form.code ?? '', form.code_verifier ?? '') ??
			tokenResponse({ account_id: account })
		);
	}
	if (url.endsWith('/users/get_current_account')) {
		return script.account?.() ?? json({ email: 'user@example.com' });
	}
	if (url.endsWith('/auth/token/revoke')) return script.revoke?.() ?? json({});

	return json({ error: 'unexpected_url' }, 500);
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const DEFAULT_ACCOUNT = 'dbid:1';

export const tokenResponse = (over: Record<string, unknown> = {}): Response =>
	json({
		access_token: 'access-1',
		refresh_token: 'refresh-1',
		expires_in: 14400,
		account_id: DEFAULT_ACCOUNT,
		...over,
	});

export interface DropboxCall {
	url: string;
	form: Record<string, string>;
	authorization: string | undefined;
}

export const dropboxStub = (script: DropboxScript = {}) => {
	const calls: DropboxCall[] = [];
	/** Which Dropbox account the next exchange reports. */
	const account = new Map<'account', string>();

	const doFetch = (url: string, init: RequestInit): Promise<Response> => {
		const body = typeof init.body === 'string' ? init.body : '';
		const form = Object.fromEntries(new URLSearchParams(body));
		const headers = new Headers(init.headers);
		calls.push({ url, form, authorization: headers.get('authorization') ?? undefined });

		return Promise.resolve(
			answer(script, url, form, account.get('account') ?? DEFAULT_ACCOUNT)
		);
	};

	return {
		fetch: doFetch,
		calls,
		/** Point the next exchange at a different Dropbox account. */
		as: (id: string): void => {
			account.set('account', id);
		},
	};
};

/**
 * A credential exactly as the PWA makes one: 32 random bytes the browser keeps,
 * behind a version prefix. The server is only ever told its hash.
 */
export const newCredential = (): string => `${CREDENTIAL_PREFIX}${randomBase64Url(32)}`;

/**
 * A well-formed hash for a test that does not care which credential it stands
 * for — the shape is all `/start` checks.
 */
export const ANY_HASH = 'A'.repeat(43);

/** What `/start` hands back, for a test that only wants to read the URL. */
export const authorizeUrlOf = async (response: Response): Promise<URL> => {
	const body: { authorizeUrl: string } = await response.json();
	return new URL(body.authorizeUrl);
};

export interface ConnectOptions {
	/** Which provider account the scripted provider reports for this flow. */
	account?: string;
	provider?: 'dropbox' | 'onedrive' | 'gdrive';
	/** Reuse a jar to reconnect from the same browser. */
	jar?: Jar;
	/** Reuse a credential to test what happens when a hash repeats. */
	credential?: string;
	returnTo?: string;
	/** Skip the POST and forge a flow cookie some other way. */
	start?: (jar: Jar, credentialHash: string) => Promise<Response>;
}

export const buildApp = (
	options: Partial<CreateAppOptions> & { script?: DropboxScript; db?: D1Database } = {}
) => {
	// Supplied by the one test that needs a database which answers a read the way
	// a concurrent transaction would, rather than the way this one wrote it.
	const db = options.db ?? createD1();
	const stub = dropboxStub(options.script);
	const app = createApp({
		config: options.config ?? testConfig(),
		fetch: options.fetch ?? stub.fetch,
		// Short enough that a test for the deadline is a test, not a wait.
		providerTimeoutMs: options.providerTimeoutMs ?? 50,
		...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
		...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
	});

	/**
	 * A request against this app, carrying whatever cookies and credential the
	 * caller holds.
	 */
	const request = async (
		path: string,
		init: RequestInit & { cookies?: Jar; credential?: string } = {}
	): Promise<Response> => {
		const headers = new Headers(init.headers);
		const cookie = init.cookies?.header();
		if (cookie !== undefined) headers.set('cookie', cookie);
		if (init.credential !== undefined) {
			headers.set('authorization', `Bearer ${init.credential}`);
		}
		// The app checks `Origin` on state-changing methods, so send what a
		// browser on this origin would send.
		if (!headers.has('origin')) headers.set('origin', 'https://notes.example.com');

		return app.fetch(
			new Request(`https://notes.example.com${path}`, {
				...init,
				headers,
				redirect: 'manual',
			}),
			{
				DB: db,
			}
		);
	};

	/** Start a flow the way the PWA does: a same-origin POST carrying the hash. */
	const startConnect = (
		provider: string,
		options: { jar?: Jar; credentialHash?: string; returnTo?: string } = {}
	): Promise<Response> => {
		const { credentialHash = ANY_HASH, returnTo } = options;
		return request(`/api/auth/connect/${provider}/start`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				credentialHash,
				...(returnTo === undefined ? {} : { returnTo }),
			}),
			...(options.jar === undefined ? {} : { cookies: options.jar }),
		});
	};

	/**
	 * The whole connect flow, ending with a credential the device holds. The
	 * plaintext is generated here and only its hash is ever sent, which is what
	 * lets a test grep every response for a secret it knows.
	 */
	const connect = async (options: ConnectOptions = {}) => {
		const {
			account = DEFAULT_ACCOUNT,
			provider = 'dropbox',
			jar = createJar(),
			credential = newCredential(),
			returnTo,
		} = options;
		stub.as(account);

		const hash = await hashCredential(credential);
		const start = jar.absorb(
			await (options.start?.(jar, hash) ??
				startConnect(provider, { jar, credentialHash: hash, returnTo }))
		);

		const state = flowStateOf(jar);
		const callback = jar.absorb(
			await request(`/api/auth/connect/${provider}/callback?code=the-code&state=${state}`, {
				cookies: jar,
			})
		);

		return { jar, credential, start, callback, state };
	};

	return { app, db, stub, request, connect, startConnect };
};

/**
 * The cookie names a secure deployment uses. They carry the `__Host-` prefix,
 * so a test that hard-coded the bare name would silently stop finding them.
 */
export const cookieNames = {
	flow: flowCookieName(true),
	insecure: { flow: flowCookieName(false) },
};

/** The flow cookie's payload, decoded the way `readFlowState` decodes it. */
export const flowPayload = (jar: Jar): Record<string, unknown> => {
	const [encoded = ''] = (
		jar.get(flowCookieName(true)) ??
		jar.get(flowCookieName(false)) ??
		''
	).split('.');
	return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Record<string, unknown>;
};

export const flowStateOf = (jar: Jar): string => String(flowPayload(jar).state);

/**
 * A cookie jar, because half of what these routes do is set and read cookies,
 * and `fetch` in Node does not keep them for us.
 */
export type Jar = ReturnType<typeof createJar>;

export const createJar = () => {
	const cookies = new Map<string, string>();

	return {
		/** Apply a response's `Set-Cookie` headers, deletions included. */
		absorb: (response: Response): Response => {
			for (const value of response.headers.getSetCookie()) {
				const [pair = ''] = value.split(';');
				const index = pair.indexOf('=');
				const name = pair.slice(0, index).trim();
				// Hono percent-encodes the value on the way out and decodes it on the
				// way in; a jar that skipped the decode would only work for payloads
				// that happen to contain nothing needing an escape.
				const content = decodeURIComponent(pair.slice(index + 1));
				// An expired cookie is a deletion, which is what `Max-Age=0` means.
				if (/max-age=0/i.test(value)) cookies.delete(name);
				else cookies.set(name, content);
			}
			return response;
		},

		get: (name: string): string | undefined => cookies.get(name),
		set: (name: string, value: string): void => {
			cookies.set(name, value);
		},
		header: (): string | undefined =>
			cookies.size === 0
				? undefined
				: [...cookies]
						.map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
						.join('; '),
	};
};
