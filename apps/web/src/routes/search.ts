import { ENTITLEMENT_CODES, type EntitlementCode, ROOT } from '@skysa/core';

/**
 * What the URL says about which folder and note are open. Split out from the
 * route so it can be tested without rendering the app, because the round trip
 * through the URL is where the root folder is easy to lose: `ROOT` is `''`, and
 * an empty search param is indistinguishable from an absent one. The URL
 * therefore spells the root `/`, and the two are translated here — nothing
 * inside the app has to know about the sentinel.
 */

export interface AppSearch {
	/** Absent until the user picks a notebook; the first one is opened instead. */
	folder?: string;
	note?: string;
	/**
	 * How connecting a storage account went, set by `apps/api` on the way back
	 * from the provider. Read once and removed.
	 */
	connect?: ConnectOutcome;
	/**
	 * Beside a `refused`, which kind of refusal it was, from the fixed list the
	 * operator's policy chooses from (`ENTITLEMENT_CODES`). Read and removed
	 * with `connect`.
	 */
	code?: EntitlementCode;
}

/**
 * Exactly what the callback can redirect with — `Outcome` in
 * `apps/api/src/routes/connect.ts`, and nothing beside it.
 *
 * `conflict`, `signin` and `occupied` were here until 2026-09-18. Phase 7
 * retired all three on the server when connections stopped aggregating under a
 * user, and the last of them cannot come back: `signin` rendered "Sign in
 * before connecting storage", and there is no sign-in (docs/ARCHITECTURE.md §6). A
 * message the server has no way to ask for is one nobody can be shown and
 * nobody can test, and this one described a product that does not exist.
 */
export const CONNECT_OUTCOMES = ['ok', 'denied', 'failed', 'partial', 'refused'] as const;

export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

const ROOT_SEARCH = '/';

/** A URL `folder` value as a folder path. */
export const folderFromSearch = (value: string | undefined): string | undefined =>
	value === ROOT_SEARCH ? ROOT : value;

/** A folder path as a URL `folder` value. */
export const folderToSearch = (path: string): string => (path === ROOT ? ROOT_SEARCH : path);

/**
 * Anything at all can arrive in the query string — a hand-edited URL, a stale
 * bookmark — so each field is taken only when it is a non-empty string.
 *
 * Every key is returned every time, `undefined` when refused, and that is what
 * makes this a validator rather than a suggestion. The router builds what
 * `Route.useSearch()` returns as `{ ...parentSearch, ...validated }`
 * (router-core `matchRoutesInternal`), and the root route's share of that is
 * the raw query, each value already through `JSON.parse`. A key merely left
 * out here is therefore still there: `?connect=signin` reached the component,
 * and `?note={"a":1}` reached `db.notes.get` as an object and took the app
 * down from a link. An explicit `undefined` overrides the raw value in the
 * spread, and `stringifySearch` drops it again on the way back to the URL.
 */
export const parseSearch = (search: Record<string, unknown>): AppSearch => ({
	folder: typeof search.folder === 'string' && search.folder !== '' ? search.folder : undefined,
	note: typeof search.note === 'string' && search.note !== '' ? search.note : undefined,
	connect: CONNECT_OUTCOMES.find((outcome) => outcome === search.connect),
	code: ENTITLEMENT_CODES.find((code) => code === search.code),
});
