import { PROVIDER_KINDS, type ProviderKind } from '@skysa/core';
import { z } from 'zod';

/**
 * The typed client for `apps/api`. Only tokens and connection metadata cross
 * this boundary — never a note (CLAUDE.md). Every response is parsed rather than
 * trusted: the Worker is ours, but the thing in between is a network, a service
 * worker and possibly a captive portal, and a page of HTML read as a connection
 * list would bind the user's notes to `undefined`.
 *
 * Each call answers with a result rather than throwing for the outcomes the app
 * has to handle — signed out, not entitled, reauthorize — and throws only for a
 * failure it cannot do anything about but report: offline, a 5xx, a malformed
 * body.
 */

const AUTH_MODES = ['storage-first', 'account-first'] as const;

const configSchema = z.object({
	authMode: z.enum(AUTH_MODES),
	// A provider this build has never heard of is dropped rather than failing
	// the whole config: a newer Worker in front of an older cached app.
	providers: z
		.array(z.string())
		.transform((kinds) =>
			kinds.filter((kind): kind is ProviderKind =>
				(PROVIDER_KINDS as readonly string[]).includes(kind)
			)
		),
});

export type InstanceConfig = z.infer<typeof configSchema>;

const connectionSchema = z.object({
	id: z.string().min(1),
	provider: z.enum(PROVIDER_KINDS),
	displayName: z.string().nullable(),
	createdAt: z.number(),
	lastUsedAt: z.number().nullable(),
});

export type Connection = z.infer<typeof connectionSchema>;

const connectionsSchema = z.object({ connections: z.array(z.unknown()) });

/**
 * A row for a provider this build has no adapter for — a newer Worker's — is
 * left out, so it does not hide the rows this build can use. Any other row it
 * cannot read fails the whole list: dropped, a changed field would read as "no
 * connections", and the app unbinds on that.
 */
const unknownProvider = (row: unknown): boolean => {
	const tagged = z.object({ provider: z.string() }).safeParse(row);
	return tagged.success && !(PROVIDER_KINDS as readonly string[]).includes(tagged.data.provider);
};

const tokenSchema = z.object({ accessToken: z.string().min(1), expiresAt: z.number() });

export type AccessToken = z.infer<typeof tokenSchema>;

const errorSchema = z.object({ error: z.string() });

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
	/** Resolved per call, so a test can stub the global after the client exists. */
	fetch?: FetchLike;
	/** Prefix for every route. The Worker serves the app and `/api` from one origin. */
	base?: string;
}

/** The API refused for a reason the app answers in words, not as a fault. */
export type Refusal = 'sign_in_required' | 'reauthorize_required' | 'not_entitled' | 'not_found';

const REFUSALS: readonly Refusal[] = [
	'sign_in_required',
	'reauthorize_required',
	'not_entitled',
	'not_found',
];

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export class ApiError extends Error {
	override readonly name = 'ApiError';

	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

export interface ApiClient {
	readonly config: () => Promise<InstanceConfig>;
	readonly connections: () => Promise<Result<Connection[]>>;
	readonly disconnect: (connectionId: string) => Promise<Result<{ revoked: boolean }>>;
	readonly token: (connectionId: string) => Promise<Result<AccessToken>>;
	/**
	 * Where to send the browser to connect an account. A navigation, not a
	 * fetch: the provider's consent page has to be a real page.
	 */
	readonly connectUrl: (provider: ProviderKind, returnTo: string) => string;
}

export const createApiClient = (options: ApiClientOptions = {}): ApiClient => {
	const base = options.base ?? '/api';
	const doFetch: FetchLike = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);

	const call = async <T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit = {}
	): Promise<Result<T>> => {
		const response = await doFetch(`${base}${path}`, {
			...init,
			// Same origin in production and through the dev proxy; said anyway,
			// because the session cookie is the whole of the authentication.
			credentials: 'same-origin',
			headers: { accept: 'application/json', ...init.headers },
		});
		const body: unknown = await response.json().catch(() => undefined);

		if (!response.ok) {
			const refusal = errorSchema.safeParse(body);
			if (refusal.success && (REFUSALS as readonly string[]).includes(refusal.data.error)) {
				return { ok: false, refusal: refusal.data.error as Refusal };
			}
			throw new ApiError(
				`${init.method ?? 'GET'} ${path} failed with ${String(response.status)}`,
				response.status
			);
		}

		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			throw new ApiError(
				`${path} answered with a body this app cannot read`,
				response.status
			);
		}
		return { ok: true, value: parsed.data };
	};

	return {
		config: async () => {
			const result = await call('/config', configSchema);
			// `/config` refuses nobody; a refusal here is a Worker this app does
			// not understand.
			if (!result.ok) throw new ApiError(`/config refused: ${result.refusal}`, 0);
			return result.value;
		},

		connections: async () => {
			const result = await call('/connections', connectionsSchema);
			if (!result.ok) return result;
			const rows = z
				.array(connectionSchema)
				.safeParse(result.value.connections.filter((row) => !unknownProvider(row)));
			if (!rows.success) {
				throw new ApiError(
					'/connections answered with a connection this app cannot read',
					200
				);
			}
			return { ok: true, value: rows.data };
		},

		disconnect: (connectionId) =>
			call(
				`/connections/${encodeURIComponent(connectionId)}`,
				z.object({ revoked: z.boolean() }),
				{ method: 'DELETE' }
			),

		token: (connectionId) =>
			call('/token', tokenSchema, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ connectionId }),
			}),

		connectUrl: (provider, returnTo) =>
			`${base}/auth/connect/${encodeURIComponent(provider)}/start?returnTo=${encodeURIComponent(returnTo)}`,
	};
};

export const api = createApiClient();
