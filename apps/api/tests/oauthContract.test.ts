import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import {
	allProvidersConfig,
	authorizeUrlOf,
	buildApp,
	type DropboxScript,
	googleTokenResponse,
	microsoftTokenResponse,
	testConfig,
} from './harness.js';

/**
 * What every provider whose grant comes with an ID token does the same way,
 * asked of each (#450). Where they differ — Google's scope that can be
 * unticked, Microsoft's tenant and rotating refresh token — stays in
 * `gdrive.test.ts` and `onedrive.test.ts`. Dropbox names its account from an
 * API call, not a token, and is not one of these.
 */

const PROVIDERS = [
	{
		provider: 'gdrive',
		host: 'accounts.google.com',
		fallbackName: 'Google Drive',
		clientSecret: 'google-client-secret',
		answer: (response: () => Response): DropboxScript => ({ google: response }),
		tokenResponse: googleTokenResponse,
	},
	{
		provider: 'onedrive',
		host: 'login.microsoftonline.com',
		fallbackName: 'OneDrive',
		clientSecret: 'ms-client-secret',
		answer: (response: () => Response): DropboxScript => ({ microsoft: response }),
		tokenResponse: microsoftTokenResponse,
	},
] as const;

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(PROVIDERS)('$provider', (each) => {
	const { provider, answer, tokenResponse } = each;
	const connectWith = (response: () => Response) => {
		const app = buildApp({ config: allProvidersConfig(), script: answer(response) });
		return { app, connected: app.connect({ provider }) };
	};

	it('is not offered where the operator has not enabled it', async () => {
		const app = buildApp({ config: testConfig() });
		expect((await app.startConnect(provider)).status).toBe(404);
	});

	it('says so plainly when it is enabled without credentials', async () => {
		const config = allProvidersConfig();
		const app = buildApp({
			config: { ...config, oauth: { ...config.oauth, [provider]: undefined } },
		});
		expect((await app.startConnect(provider)).status).toBe(501);
	});

	it('starts for a device that already holds another provider', async () => {
		// This used to be refused, because in the old model any connected account
		// signed you in as its user, so holding two crossed the authorisation
		// between them. Each connection is now its own silo, and a device may
		// hold as many as the person has accounts.
		const app = buildApp({ config: allProvidersConfig() });
		const { jar } = await app.connect({ account: 'dbid:a', provider: 'dropbox' });

		const response = await app.startConnect(provider, { jar, returnTo: '/n' });
		expect(response.status).toBe(200);
		expect((await authorizeUrlOf(response)).hostname).toBe(each.host);
	});

	it('refuses an ID token issued to some other app', async () => {
		const { app, connected } = connectWith(() => tokenResponse({}, { aud: 'another-app' }));
		const { callback } = await connected;

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant with no refresh token', async () => {
		const { app, connected } = connectWith(() => tokenResponse({ refresh_token: undefined }));
		const { callback } = await connected;

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('names the connection after the provider when the account has no email', async () => {
		const { app, connected } = connectWith(() => tokenResponse({}, { email: undefined }));
		await connected;

		const [row] = await rows(app.db);
		expect(row?.displayName).toBe(each.fallbackName);
	});

	it('logs a failed exchange for the operator, with the code and nothing else', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { connected } = connectWith(
			() =>
				new Response(
					JSON.stringify({
						error: 'invalid_client',
						error_description: 'echoes the-code',
					}),
					{ status: 401 }
				)
		);
		const { callback } = await connected;

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		const logged = log.mock.calls.flat().join('\n');
		expect(logged).toContain('invalid_client');
		expect(logged).not.toContain('echoes');
		expect(logged).not.toContain(each.clientSecret);
	});
});
