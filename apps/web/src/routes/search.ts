import { ENTITLEMENT_CODES, type EntitlementCode } from '@skysa/core';

import { isShareId } from '../share/received.js';

/**
 * What the query string says: the messages other pages leave for the app on
 * the way in — a connect's outcome, an operator's way back, a share — each read
 * once and taken out. Where the user is is not here: it is in the hash and the
 * history entry (`place.ts`). Split out from the route so it can be tested
 * without rendering the app.
 */

export interface AppSearch {
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
	/**
	 * Open the way to connect storage at the gate's code field: where an
	 * operator's page sends someone back to once they have a code
	 * (`ConnectGate`), the gate's link having taken them there in this same
	 * window. `code` is the only value. Read once and removed, as `connect` is.
	 */
	enter?: 'code';
	/**
	 * Something shared to the app, kept by the service worker under this id
	 * (`src/share/`). Read once and removed.
	 */
	share?: string;
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
export const CONNECT_OUTCOMES = [
	'ok',
	'denied',
	'failed',
	'partial',
	'refused',
	'expired',
] as const;

export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

/** Keys the query string no longer carries (`parseSearch`). */
export interface RetiredSearch {
	folder?: undefined;
	note?: undefined;
}

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
 *
 * `folder` and `note` are refused outright. They said where the user was until
 * that moved to the hash (2026-10-06), and a link from before then would
 * otherwise carry them along through every navigation after it.
 */
export const parseSearch = (search: Record<string, unknown>): AppSearch & RetiredSearch => ({
	folder: undefined,
	note: undefined,
	connect: CONNECT_OUTCOMES.find((outcome) => outcome === search.connect),
	code: ENTITLEMENT_CODES.find((code) => code === search.code),
	enter: search.enter === 'code' ? 'code' : undefined,
	share: typeof search.share === 'string' && isShareId(search.share) ? search.share : undefined,
});
