import { AUTH_MODES, type AuthMode, PROVIDER_KINDS, type ProviderKind } from '@skysa/core';
import { z } from 'zod';

import { fromBase64Url } from './crypto.js';
import { formatIssues } from './json.js';
import { isOAuthProvider, type OAuthProviderKind } from './oauth/providers.js';
import type { OAuthCredentials } from './oauth/types.js';

/**
 * Validation for the operator's environment. This module never reads the
 * environment itself — `src/worker.ts` is the only place that touches it and
 * passes the result into `createApp`. See docs/ARCHITECTURE.md §6.
 */

const booleanish = z
	.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
	.transform((v) => v === true || v === 'true' || v === '1');

const providerList = z
	.string()
	.transform((v) =>
		v
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	)
	.pipe(
		z
			.array(z.enum(PROVIDER_KINDS))
			.nonempty('ENABLED_PROVIDERS must name at least one provider')
	);

/**
 * Each OAuth provider's settings, by name: the one place they are spelled out
 * (#450). Keyed by the flows in `oauth/providers.ts`, so a provider with a
 * flow and no settings here, or settings and no flow, does not compile; the
 * schema, the check that an enabled provider has its settings, and the
 * credentials `createApp` is handed all read it.
 */
const OAUTH_ENV = {
	gdrive: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
	onedrive: { id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' },
	dropbox: { id: 'DROPBOX_CLIENT_ID', secret: 'DROPBOX_CLIENT_SECRET' },
} as const satisfies Record<OAuthProviderKind, { id: string; secret: string }>;

type CredentialVar = (typeof OAUTH_ENV)[OAuthProviderKind]['id' | 'secret'];

/** Every provider's two settings, optional here: whether one is required is `missingCredentialIssues`'s to say. */
const credentialVars = Object.fromEntries(
	Object.values(OAUTH_ENV)
		.flatMap(({ id, secret }) => [id, secret])
		.map((name) => [name, z.string().optional()])
) as Record<CredentialVar, z.ZodOptional<z.ZodString>>;

const oauthCredentials = z.object({
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
});

const rawEnvSchema = z.object({
	AUTH_MODE: z.enum(AUTH_MODES).default('storage-first'),
	// `prefault` (not `default`): the fallback is the raw string, fed through the
	// same split-and-validate pipeline as an operator-supplied value.
	//
	// Only what is implemented. Defaulting to all four would refuse to boot
	// until an operator had registered apps with Google *and* Microsoft, for
	// flows that do not exist yet.
	ENABLED_PROVIDERS: providerList.prefault('dropbox'),

	/** Public origin of this deployment; OAuth redirect URIs are built from it. */
	APP_ORIGIN: z.url(),

	/**
	 * Base64 of 32 random bytes. `openssl rand -base64 32`.
	 *
	 * Checked here rather than at first use: a key of the wrong length is an
	 * operator mistake, and finding it at boot is the difference between a
	 * deployment that refuses to start and one that fails the first time
	 * somebody tries to connect an account.
	 */
	SECRETS_KEY: z
		.string()
		.min(1)
		.refine((value) => {
			try {
				// The decoder `importSecretKey` uses, so the two agree on every key.
				return fromBase64Url(value).length === 32;
			} catch {
				return false;
			}
		}, 'SECRETS_KEY must be base64 of exactly 32 bytes'),
	/** Names the current key so rows encrypted with an older one stay readable. */
	SECRETS_KEY_ID: z.string().min(1).default('k1'),

	/**
	 * Deprecated, and does nothing: it was for a WebDAV proxy that is not built
	 * (docs/ARCHITECTURE.md §5.4). Still read, and warned of at boot
	 * (`envWarnings`), so a deployment that sets it keeps booting; it goes in
	 * #118's breaking change. Any value boots: one this would once have refused
	 * reads as false, since nothing reads it either way.
	 */
	WEBDAV_ALLOW_PRIVATE: booleanish.default(false).catch(false),

	/**
	 * Run the change relay (docs/ARCHITECTURE.md §6, "Change relay"). Off by
	 * default: it tells the server when each connection is edited, and on
	 * Workers Free it spends the daily request cap that token refresh shares.
	 */
	RELAY: booleanish.default(false),

	...credentialVars,
	/** Entra tenant; `common` covers personal and work accounts. */
	MICROSOFT_TENANT: z.string().min(1).default('common'),
});

export type AppConfig = {
	authMode: AuthMode;
	enabledProviders: ProviderKind[];
	appOrigin: string;
	/** False only for a plain-HTTP origin, which in practice means localhost. */
	cookiesSecure: boolean;
	secretsKey: string;
	secretsKeyId: string;
	/** Deprecated, and does nothing; see `WEBDAV_ALLOW_PRIVATE`. */
	webdavAllowPrivate: boolean;
	/** Whether the operator turned the change relay on. The entry decides what carries it. */
	relay: boolean;
	/** Each enabled OAuth provider's app; OneDrive's carries its tenant. */
	oauth: Partial<Record<OAuthProviderKind, OAuthCredentials>>;
};

/**
 * Cross-field rules, checked separately from the object schema.
 *
 * Zod skips refinements once the base object fails, which would make an
 * operator fix one missing variable per run. Running these independently means
 * a single run reports everything that is wrong.
 */
const missingCredentialIssues = (raw: Record<string, unknown>): string[] => {
	const providers = rawEnvSchema.shape.ENABLED_PROVIDERS.safeParse(raw.ENABLED_PROVIDERS);
	if (!providers.success) return [];

	return providers.data
		.filter(isOAuthProvider)
		.flatMap((provider) =>
			[OAUTH_ENV[provider].id, OAUTH_ENV[provider].secret]
				.filter((key) => !raw[key])
				.map((key) => `${key}: required because ENABLED_PROVIDERS includes "${provider}"`)
		);
};

/**
 * `account-first` is not built and is **not going to be** (docs/ARCHITECTURE.md §6, "No
 * sign-in separate from storage"). It used to be accepted and then behave
 * exactly like `storage-first`, which is the worst of the three possibilities:
 * an operator who set it believed connections were gated behind a sign-in they
 * had configured, and they were not. Refusing at boot is the only answer that
 * cannot be misread.
 *
 * The whole variable goes in a change of its own — removing it is breaking for
 * anyone with it in a `wrangler.toml` (issue #118 lists every site).
 * Until then this refusal is what keeps the setting from meaning anything.
 */
const unbuiltAuthModeIssues = (raw: Record<string, unknown>): string[] =>
	raw.AUTH_MODE === 'account-first'
		? [
				'AUTH_MODE: account-first is not implemented and will not be (docs/ARCHITECTURE.md §6). ' +
					'Use storage-first, where each connected account is its own silo.',
			]
		: [];

const crossFieldIssues = (raw: Record<string, unknown>): string[] => [
	...missingCredentialIssues(raw),
	...unbuiltAuthModeIssues(raw),
];

/** The environment as a record, whatever the runtime handed over. */
const recordOf = (raw: unknown): Record<string, unknown> =>
	(typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

export const parseEnv = (raw: unknown): AppConfig => {
	const record = recordOf(raw);
	const result = rawEnvSchema.safeParse(record);

	const issues = [
		...(result.success ? [] : formatIssues(result.error.issues)),
		...crossFieldIssues(record),
	];
	if (!result.success || issues.length > 0) {
		throw new Error(`Invalid environment:\n${issues.map((i) => `  ${i}`).join('\n')}`);
	}

	const env = result.data;

	const oauth = env.ENABLED_PROVIDERS.filter(isOAuthProvider).reduce<AppConfig['oauth']>(
		(built, provider) => ({
			...built,
			[provider]: {
				...oauthCredentials.parse({
					clientId: env[OAUTH_ENV[provider].id],
					clientSecret: env[OAUTH_ENV[provider].secret],
				}),
				// Microsoft's alone: which accounts may sign in.
				...(provider === 'onedrive' && { tenant: env.MICROSOFT_TENANT }),
			},
		}),
		{}
	);

	return {
		authMode: env.AUTH_MODE,
		// Accepted, so a deployment that lists it keeps booting, but not offered:
		// its connect answers 404 (`envWarnings` says so at boot).
		enabledProviders: env.ENABLED_PROVIDERS.filter((provider) => provider !== 'webdav'),
		appOrigin: env.APP_ORIGIN.replace(/\/$/, ''),
		cookiesSecure: env.APP_ORIGIN.startsWith('https://'),
		secretsKey: env.SECRETS_KEY,
		secretsKeyId: env.SECRETS_KEY_ID,
		webdavAllowPrivate: env.WEBDAV_ALLOW_PRIVATE,
		relay: env.RELAY,
		oauth,
	};
};

/**
 * Settings that are accepted and do nothing, each said in a line for the
 * Worker's log at boot (#450). Refusing them would break anyone who has them
 * set, so they warn until #118's breaking change removes them.
 */
export const envWarnings = (raw: unknown): string[] => {
	const record = recordOf(raw);
	const providers = rawEnvSchema.shape.ENABLED_PROVIDERS.safeParse(record.ENABLED_PROVIDERS);
	const listed = providers.success ? providers.data : [];
	return [
		...(listed.includes('webdav')
			? [
					'ENABLED_PROVIDERS: webdav is not built (docs/ARCHITECTURE.md §5.4), so it is not ' +
						'offered and its connect answers 404. Remove it.' +
						(listed.every((provider) => provider === 'webdav')
							? ' Nothing else is listed, so this instance offers no provider to connect.'
							: ''),
				]
			: []),
		...(record.WEBDAV_ALLOW_PRIVATE === undefined
			? []
			: [
					'WEBDAV_ALLOW_PRIVATE: deprecated, and does nothing, since WebDAV is not built. Remove it.',
				]),
	];
};
