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
 * the whole request, body included. A request that carries more than a note
 * gets more (`SLOWEST_BYTES_PER_MS`).
 */
export const PROVIDER_TIMEOUT_MS = 60_000;

/**
 * The slowest connection a file is still expected to cross: 50 KB/s, a poor
 * mobile signal. An attachment can be 25 MB (#187), which at that rate takes
 * over eight minutes, and one minute for any request would cut every large
 * file off on any connection under about 3.5 Mbit/s and retry it for ever. So
 * a request is given this long per byte on top of `PROVIDER_TIMEOUT_MS`: per
 * byte it sends, from the start, and per byte the answer says it holds
 * (`Content-Length`), from when the answer begins. A note or a page of changes
 * is a few kilobytes, a few hundredths of a second here, and keeps the minute.
 */
export const SLOWEST_BYTES_PER_MS = 50;

/** What a request sends, as far as it can be known without reading it. */
const sending = (body: RequestInit['body']): number => {
	if (typeof body === 'string') return body.length;
	if (body instanceof Blob) return body.size;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
	return 0;
};

/** What an answer says it holds, or 0 where it does not say. */
const receiving = (response: Response): number => {
	const length = Number(response.headers.get('content-length') ?? '');
	return Number.isFinite(length) && length > 0 ? length : 0;
};

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
 * A request's own deadline: `ms`, and longer for the bytes it sends. Moved
 * later once the answer begins, if the bytes it says it holds need longer at
 * the slowest rate than is left — never earlier, and never later for a small
 * answer, so a note or a page of changes keeps the minute it always had.
 * Aborted as `AbortSignal.timeout` aborts, with a `TimeoutError`;
 * `AbortSignal.timeout` itself cannot be moved.
 */
const deadline = (ms: number, init: RequestInit) => {
	const controller = new AbortController();
	const abort = () => {
		controller.abort(new DOMException('the provider took too long', 'TimeoutError'));
	};
	const startedAt = Date.now();
	const first = ms + sending(init.body) / SLOWEST_BYTES_PER_MS;
	const timer = setTimeout(abort, first);
	return {
		signal: controller.signal,
		/**
		 * The answer has begun. Its timer is not cleared when its body has been
		 * read, which nothing here sees; it fires on a finished request, which
		 * an abort leaves as it was.
		 */
		answered: (response: Response) => {
			clearTimeout(timer);
			const left = startedAt + first - Date.now();
			setTimeout(abort, Math.max(left, receiving(response) / SLOWEST_BYTES_PER_MS));
		},
		failed: () => {
			clearTimeout(timer);
		},
	};
};

/**
 * `fetch`, given up on after `ms` — longer for a large file either way
 * (`SLOWEST_BYTES_PER_MS`) — unless the caller brought a signal of its own,
 * and, either way, as soon as `session` is: the sync it was for has ended (a
 * cancel, a disconnect, another source in front), and a download nobody will
 * look at should not hold the connection's lock for a minute.
 */
export const timedFetch =
	(fetch: FetchLike, ms: number, session?: AbortSignal): FetchLike =>
	async (url, init) => {
		const theirs = init.signal ?? undefined;
		const own = theirs === undefined ? deadline(ms, init) : undefined;
		const signal = theirs ?? own?.signal;
		const response = await fetch(url, {
			...init,
			...(signal === undefined
				? {}
				: { signal: session === undefined ? signal : eitherSignal(signal, session) }),
		}).catch((error: unknown) => {
			own?.failed();
			throw error;
		});
		own?.answered(response);
		return response;
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
