import { ROOT } from '@skysa/core';

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
}

export const CONNECT_OUTCOMES = [
	'ok',
	'denied',
	'failed',
	'conflict',
	'signin',
	'occupied',
] as const;

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
 */
export const parseSearch = (search: Record<string, unknown>): AppSearch => ({
	...(typeof search.folder === 'string' && search.folder !== '' ? { folder: search.folder } : {}),
	...(typeof search.note === 'string' && search.note !== '' ? { note: search.note } : {}),
	...(CONNECT_OUTCOMES.some((outcome) => outcome === search.connect)
		? { connect: search.connect as ConnectOutcome }
		: {}),
});
