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
	// The provider's id for the account: which notes are its, across the new
	// connection id every reconnect after a disconnect gets. Absent from a Worker
	// older than this app, which is the same as not knowing.
	accountId: z.string().nullable().default(null),
	createdAt: z.number(),
	lastUsedAt: z.number().nullable(),
	/** Which of the devices below is this one, so the panel need not guess. */
	grantId: z.string().min(1),
});

export type Connection = z.infer<typeof connectionSchema>;

/**
 * One device holding this connection. No hashes: the server does not return
 * them, and a leaked one is the whole of a credential's identity there.
 */
const grantSchema = z.object({
	id: z.string().min(1),
	createdAt: z.number(),
	lastUsedAt: z.number(),
	/** Past the server's idle limit: still listed, but it no longer works. */
	expired: z.boolean().default(false),
	current: z.boolean(),
});

export type Grant = z.infer<typeof grantSchema>;

const grantsSchema = z.object({ grants: z.array(grantSchema) });

const authorizeSchema = z.object({ authorizeUrl: z.url() });

const tokenSchema = z.object({ accessToken: z.string().min(1), expiresAt: z.number() });

export type AccessToken = z.infer<typeof tokenSchema>;

/**
 * `expiresAt` is by the Worker's clock, and the app compares it with this
 * device's. A device clock hours out would see every token as expired on
 * arrival and mint one for every provider request. So it is moved onto this
 * device's clock by the response's `Date`, which is the Worker's own to the
 * second — well inside the minute a token is replaced early by
 * (`sync/tokens.ts`). A response without one is taken as it is.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Date
 */
const onDeviceClock = (token: AccessToken, response: Response): AccessToken => {
	const served = Date.parse(response.headers.get('date') ?? '');
	return Number.isNaN(served)
		? token
		: { ...token, expiresAt: token.expiresAt - served + Date.now() };
};

const errorSchema = z.object({ error: z.string() });

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
	/** Resolved per call, so a test can stub the global after the client exists. */
	fetch?: FetchLike;
	/**
	 * The credential to present, asked for once per call.
	 *
	 * A function rather than a value because it lives in IndexedDB and changes
	 * underneath the client: connecting writes one, a revoked device throws one
	 * away, and switching source picks a different one. A client that had been
	 * handed a string at construction would go on presenting a credential the
	 * device no longer holds.
	 */
	credential?: () => Promise<string | undefined>;
	/** Prefix for every route. The Worker serves the app and `/api` from one origin. */
	base?: string;
	/**
	 * How long a call may take before it counts as unreachable. Nothing else
	 * bounds it: the service worker does not, and a disconnect waiting on a hung
	 * request would keep the panel's buttons disabled until the browser gives up.
	 * Long enough for a disconnect, which refreshes and revokes at the provider.
	 */
	timeoutMs?: number;
}

/**
 * The API refused for a reason the app answers in words, not as a fault.
 *
 * `sign_in_required` is gone with the session it was about: there is no session
 * to expire, and every place that used to mean "wait, you may be back" now
 * means one of two definite things. `credential_required` is this device having
 * sent nothing — it has to connect. `credential_revoked` is the server saying
 * this credential reaches nothing at all: revoked from another device, or the
 * account disconnected. Either way the credential is spent for ever and the
 * only answer is to throw it away (docs/PLAN.md §6).
 */
export type Refusal =
	| 'credential_required'
	| 'credential_revoked'
	| 'reauthorize_required'
	| 'not_entitled'
	| 'not_found'
	| 'forbidden_origin';

const REFUSALS: readonly Refusal[] = [
	'credential_required',
	'credential_revoked',
	'reauthorize_required',
	'not_entitled',
	'not_found',
	'forbidden_origin',
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
	/**
	 * The one connection the presented credential reaches.
	 *
	 * Singular, and the singular matters: a list would let "not in the list" and
	 * "gone" be the same shape, and the device unbinds on this answer. A
	 * `credential_revoked` means *this connection is gone*; a thrown error —
	 * offline, a 5xx — means nothing at all, and the device keeps what it has.
	 */
	readonly connection: () => Promise<Result<Connection>>;
	/** The devices holding this connection, so a theft is visible and revocable. */
	readonly grants: () => Promise<Result<Grant[]>>;
	/** Sign one device out, this one included. */
	readonly revokeGrant: (grantId: string) => Promise<Result<{ ok: boolean }>>;
	/** Disconnect the account this credential reaches. No id: the credential says which. */
	readonly disconnect: () => Promise<Result<{ revoked: boolean }>>;
	/** Mint a provider access token. No id, for the same reason. */
	readonly token: () => Promise<Result<AccessToken>>;
	/**
	 * Ask where to send the browser to connect an account.
	 *
	 * A POST that answers a URL, rather than a link that redirects. The hash is
	 * caller-supplied, and a `GET` carrying it would be a session-fixation hole:
	 * a link with the attacker's hash, consented to by the victim, hands the
	 * attacker a live credential to the victim's storage. A navigation cannot
	 * carry a body, and the body is what keeps the hash out of the URL.
	 */
	readonly startConnect: (
		provider: ProviderKind,
		credentialHash: string,
		returnTo: string
	) => Promise<Result<string>>;
	/**
	 * The same client presenting one particular credential.
	 *
	 * For the two callers that know which credential they mean rather than
	 * asking the store: claiming a connection the user has just consented to,
	 * whose id is not known until the server answers, and asking after a
	 * connection that is not the active one.
	 */
	readonly withCredential: (credential: string) => ApiClient;
}

export const createApiClient = (options: ApiClientOptions = {}): ApiClient => {
	const rebind = (credential: string): ApiClient =>
		createApiClient({ ...options, credential: () => Promise.resolve(credential) });

	const base = options.base ?? '/api';
	const timeoutMs = options.timeoutMs ?? 30_000;
	const doFetch: FetchLike = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
	const heldCredential = options.credential ?? (() => Promise.resolve(undefined));

	const call = async <T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit = {},
		adapt: (value: T, response: Response) => T = (value) => value
	): Promise<Result<T>> => {
		const credential = await heldCredential();
		const response = await doFetch(`${base}${path}`, {
			...init,
			// Still said, though the credential and not a cookie is now the whole
			// of the authentication: the flow cookie rides on `/start` and its
			// callback, and it is `__Host-` prefixed and signed.
			credentials: 'same-origin',
			// Binding follows what the server says, so a stored answer replayed
			// after the world moved would unbind a live connection or hand back
			// a revoked token. The API says `no-store` too; this is the half the
			// browser's own HTTP cache obeys without being asked.
			cache: 'no-store',
			headers: {
				accept: 'application/json',
				// Never sent ambiently: the browser attaches nothing of its own, so
				// every authenticated call says so here. A call with no credential is
				// made anyway — `/config` needs none, and the rest answer
				// `credential_required`, which is an answer the app acts on.
				...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
				...init.headers,
			},
			signal: AbortSignal.timeout(timeoutMs),
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
		return { ok: true, value: adapt(parsed.data, response) };
	};

	return {
		config: async () => {
			const result = await call('/config', configSchema);
			// `/config` refuses nobody; a refusal here is a Worker this app does
			// not understand.
			if (!result.ok) throw new ApiError(`/config refused: ${result.refusal}`, 0);
			return result.value;
		},

		connection: () => call('/connection', connectionSchema),

		grants: async () => {
			const result = await call('/connection/grants', grantsSchema);
			return result.ok ? { ok: true, value: result.value.grants } : result;
		},

		revokeGrant: (grantId) =>
			call(
				`/connection/grants/${encodeURIComponent(grantId)}`,
				z.object({ ok: z.boolean() }),
				{
					method: 'DELETE',
				}
			),

		disconnect: () =>
			call('/connection', z.object({ revoked: z.boolean() }), { method: 'DELETE' }),

		token: () => call('/token', tokenSchema, { method: 'POST' }, onDeviceClock),

		withCredential: rebind,

		startConnect: async (provider, credentialHash, returnTo) => {
			const result = await call(
				`/auth/connect/${encodeURIComponent(provider)}/start`,
				authorizeSchema,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ credentialHash, returnTo }),
				}
			);
			return result.ok ? { ok: true, value: result.value.authorizeUrl } : result;
		},
	};
};

export const api = createApiClient();
