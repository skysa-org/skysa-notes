import { createApp, type CreateAppOptions } from '../src/app.js';
import { fromBase64Url } from '../src/crypto.js';
import { type AppConfig, parseEnv } from '../src/env.js';
import { flowCookieName, sessionCookieName } from '../src/session.js';
import { createD1 } from './d1.js';

/**
 * One app, one in-memory database, one scripted Dropbox. Every test builds its
 * own so nothing leaks between them.
 */

export const SECRETS_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
	...parseEnv({
		APP_ORIGIN: 'https://notes.example.com',
		SECRETS_KEY,
		ENABLED_PROVIDERS: 'dropbox',
		DROPBOX_CLIENT_ID: 'client-id',
		DROPBOX_CLIENT_SECRET: 'client-secret',
	}),
	...overrides,
});

export interface DropboxScript {
	/** Code → the token response Dropbox would give for it. */
	exchange?: (code: string, verifier: string) => Response;
	refresh?: (refreshToken: string) => Response;
	account?: () => Response;
	revoke?: () => Response;
}

const answer = (
	script: DropboxScript,
	url: string,
	form: Record<string, string>,
	account: string
): Response => {
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

export const buildApp = (options: Partial<CreateAppOptions> & { script?: DropboxScript } = {}) => {
	const db = createD1();
	const stub = dropboxStub(options.script);
	const app = createApp({
		config: options.config ?? testConfig(),
		fetch: options.fetch ?? stub.fetch,
		// Short enough that a test for the deadline is a test, not a wait.
		providerTimeoutMs: options.providerTimeoutMs ?? 50,
		...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
	});

	/** A request against this app, carrying whatever cookies the caller holds. */
	const request = (path: string, init: RequestInit & { cookies?: Jar } = {}) => {
		const headers = new Headers(init.headers);
		const cookie = init.cookies?.header();
		if (cookie !== undefined) headers.set('cookie', cookie);
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

	/**
	 * The whole connect flow, which is also how a test gets a signed-in user:
	 * in storage-first the first connected account *is* the account.
	 */
	const connect = async (jar = createJar(), account = DEFAULT_ACCOUNT) => {
		stub.as(account);
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		const state = flowStateOf(jar);
		const callback = jar.absorb(
			await request(`/api/auth/connect/dropbox/callback?code=the-code&state=${state}`, {
				cookies: jar,
			})
		);

		return { jar, callback, state };
	};

	return { app, db, stub, request, connect };
};

/**
 * The cookie names a secure deployment uses. They carry the `__Host-` prefix,
 * so a test that hard-coded the bare name would silently stop finding them.
 */
export const cookieNames = {
	session: sessionCookieName(true),
	flow: flowCookieName(true),
	insecure: { session: sessionCookieName(false), flow: flowCookieName(false) },
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
