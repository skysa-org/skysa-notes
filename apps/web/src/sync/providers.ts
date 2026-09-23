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

/**
 * Aborted when any of `signals` is. `AbortSignal.any` where the browser has it
 * (it lets go of what it listens to), and by hand where it does not.
 * https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
 */
export const eitherSignal = (...signals: AbortSignal[]): AbortSignal => {
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
	const controller = new AbortController();
	signals.forEach((signal) => {
		if (signal.aborted) controller.abort(signal.reason);
		else
			signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
	});
	return controller.signal;
};

/**
 * `fetch`, given up on after `ms` unless the caller brought a signal of its
 * own — and, either way, as soon as `session` is: the sync it was for has
 * ended (a cancel, a disconnect, another source in front), and a download
 * nobody will look at should not hold the connection's lock for a minute.
 */
export const timedFetch =
	(fetch: FetchLike, ms: number, session?: AbortSignal): FetchLike =>
	(url, init) => {
		const own = init.signal ?? AbortSignal.timeout(ms);
		return fetch(url, {
			...init,
			signal: session === undefined ? own : eitherSignal(own, session),
		});
	};

export interface ProviderFactoryOptions {
	/** Reported in the marker file. */
	appVersion: string;
	/** Resolved per call by default, so a test can stub the global. */
	fetch?: FetchLike;
	timeoutMs?: number;
}

export const createProviderFactory = (options: ProviderFactoryOptions): ProviderFactory => {
	const base = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const ms = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
	return ({ provider, clientId, getAccessToken, signal }) => {
		const fetch = timedFetch(base, ms, signal);
		const adapter = { fetch, getAccessToken, appVersion: options.appVersion, clientId };
		if (provider === 'dropbox') return createDropboxProvider(adapter);
		if (provider === 'onedrive') return createOneDriveProvider(adapter);
		if (provider === 'gdrive') return createGDriveProvider(adapter);
		return undefined;
	};
};
