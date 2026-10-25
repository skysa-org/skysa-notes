import { bodyBytes, bodyText } from './wireBody.js';

/**
 * What the HTTP stubs share: how they answer, how they record what they were
 * asked, and how a request reaches their routes.
 */

export const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

/** A request as a stub saw it, for a test to look back over. */
export interface StubRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** Where a stub sends a request, its headers' names lower-cased and its body read. */
export type StubRoute = (
	method: string,
	url: URL,
	headers: Record<string, string>,
	body: string,
	bytes: Uint8Array<ArrayBuffer>
) => Promise<Response> | Response;

/**
 * A stub's way in: each request recorded, then routed, with `observe` run
 * either side of it so the stub's change feed sees whatever the request moved.
 */
export const handler =
	(requests: StubRequest[], route: StubRoute, observe: () => void) =>
	async (raw: string, init: RequestInit): Promise<Response> => {
		const headers = Object.fromEntries(
			Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
				key.toLowerCase(),
				value,
			])
		);
		const bytes = bodyBytes(init.body);
		const body = bodyText(init.body);
		const method = init.method ?? 'GET';
		requests.push({ method, url: raw, headers, ...(body === '' ? {} : { body }) });

		observe();
		const response = await route(method, new URL(raw), headers, body, bytes);
		observe();
		return response;
	};
