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
 * byte it sends, from the start, and per byte of its answer, from when the
 * answer begins. A note or a page of changes is a few kilobytes, a few
 * hundredths of a second here, and keeps the minute.
 */
export const SLOWEST_BYTES_PER_MS = 50;

/** What a request sends, in bytes, as far as it can be known without reading it. */
const sending = (body: RequestInit['body']): number => {
	if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
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
 * A request's own deadline: `ms`, and 1 ms more for every
 * `SLOWEST_BYTES_PER_MS` bytes it sends or receives. What the answer's bytes
 * earn is credit, spent when the timer comes due, so the deadline only ever
 * moves later and nothing here reads a clock — a wall clock set back or forward
 * cannot bring it on early. Aborted as `AbortSignal.timeout` aborts, with a
 * `TimeoutError`; `AbortSignal.timeout` itself cannot be moved.
 * https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
 */
const deadline = (ms: number, init: RequestInit) => {
	const controller = new AbortController();
	const credit = new Map<'ms', number>([['ms', 0]]);
	const timer = new Map<'due', ReturnType<typeof setTimeout>>();
	const due = (): void => {
		const earned = credit.get('ms') ?? 0;
		credit.set('ms', 0);
		if (earned > 0) timer.set('due', setTimeout(due, earned));
		else controller.abort(new DOMException('the provider took too long', 'TimeoutError'));
	};
	timer.set('due', setTimeout(due, ms + sending(init.body) / SLOWEST_BYTES_PER_MS));
	return {
		signal: controller.signal,
		received: (bytes: number) => {
			credit.set('ms', (credit.get('ms') ?? 0) + bytes / SLOWEST_BYTES_PER_MS);
		},
		/** Nothing more to wait for: the request failed, or its answer has been read. */
		done: () => {
			clearTimeout(timer.get('due'));
		},
	};
};

type Deadline = ReturnType<typeof deadline>;

/**
 * The answer has begun. What it says it holds (`Content-Length`) is credited at
 * once. An answer that does not say — Dropbox does not promise to — is credited
 * as its bytes arrive, so a large download that keeps coming is never cut off
 * for want of a header, and one that stops is, `ms` after it stopped earning.
 * https://www.dropboxforum.com/discussions/101000014/dropbox-stopped-returning-content-length-in-the-response-headers-/575948
 *
 * An answer with a length keeps its timer once read, which nothing here sees;
 * it fires on a finished request, which an abort leaves as it was.
 */
const answered = (response: Response, own: Deadline): Response => {
	const length = receiving(response);
	if (response.body === null) own.done();
	if (response.body === null || length > 0) {
		own.received(length);
		return response;
	}
	const counted = new TransformStream<Uint8Array, Uint8Array>({
		transform: (chunk, stream) => {
			own.received(chunk.byteLength);
			stream.enqueue(chunk);
		},
		flush: own.done,
	});
	return new Response(response.body.pipeThrough(counted), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
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
		const own = init.signal ? undefined : deadline(ms, init);
		const signal = init.signal ?? own?.signal;
		const response = await fetch(url, {
			...init,
			signal: signal && session ? eitherSignal(signal, session) : (signal ?? session),
		}).catch((error: unknown) => {
			own?.done();
			throw error;
		});
		return own === undefined ? response : answered(response, own);
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
