import {
	createDropboxProvider,
	createGDriveProvider,
	createOneDriveProvider,
	type FetchLike,
} from '@skysa/core';

import { type ProviderFactory } from './scheduler.js';

/**
 * The storage adapters this build can sync with, for the scheduler.
 *
 * Every provider request is given a deadline. `fetch` has none of its own, and
 * a sync holds a lock every tab waits on (`sync/scheduler.ts`): one request
 * left hanging by a network that went away without saying so would otherwise
 * stop every tab syncing that connection until the browser gave up on it,
 * which can be never. Aborting it fails the sync like any other transient
 * failure, and the backoff comes back.
 * https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
 */

/**
 * Long enough for a note's upload or a page of changes on a slow connection;
 * the whole request, body included.
 */
export const PROVIDER_TIMEOUT_MS = 60_000;

/** `fetch`, given up on after `ms` unless the caller brought a signal of its own. */
export const timedFetch =
	(fetch: FetchLike, ms: number): FetchLike =>
	(url, init) =>
		fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });

export interface ProviderFactoryOptions {
	/** Reported in the marker file. */
	appVersion: string;
	/** Resolved per call by default, so a test can stub the global. */
	fetch?: FetchLike;
	timeoutMs?: number;
}

export const createProviderFactory = (options: ProviderFactoryOptions): ProviderFactory => {
	const fetch = timedFetch(
		options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
		options.timeoutMs ?? PROVIDER_TIMEOUT_MS
	);
	return ({ provider, clientId, getAccessToken }) => {
		const adapter = { fetch, getAccessToken, appVersion: options.appVersion, clientId };
		if (provider === 'dropbox') return createDropboxProvider(adapter);
		if (provider === 'onedrive') return createOneDriveProvider(adapter);
		if (provider === 'gdrive') return createGDriveProvider(adapter);
		return undefined;
	};
};
