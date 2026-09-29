import {
	alwaysAllowed,
	type ConnectCodeCheck,
	type EntitlementProvider,
	type RateLimiter,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './harness.js';

/**
 * `POST /api/connect-code`: the policy's word on a code as it is used in the
 * gate, before any connect (docs/ARCHITECTURE.md §6, "Connect codes").
 */

const GATE = {
	message: 'Sync on this server is part of the paid plan.',
	action: { label: 'Get a code', url: 'https://example.com/code' },
	connectCode: { label: 'Connect code', required: true },
};

const policy = (
	checkCode: (code: string) => Promise<unknown>
): EntitlementProvider & { checkCode: ReturnType<typeof vi.fn> } => ({
	...alwaysAllowed,
	gate: GATE,
	checkCode: vi.fn(checkCode as (code: string) => Promise<ConnectCodeCheck>),
});

const ask = (
	request: ReturnType<typeof buildApp>['request'],
	body: unknown,
	headers: Record<string, string> = {}
) =>
	request('/api/connect-code', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('checking a code as it is used', () => {
	it('says a code will do, and for how long, asking the policy with it trimmed', async () => {
		const entitlements = policy(() => Promise.resolve({ accepted: true, expiresIn: 840 }));
		const { request } = buildApp({ entitlements });

		const response = await ask(request, { code: '  K7QM-2XRD \n' });

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ accepted: true, expiresIn: 840 });
		expect(entitlements.checkCode).toHaveBeenCalledWith('K7QM-2XRD');
	});

	it("says a code will not, in the policy's words where it has some", async () => {
		const { request } = buildApp({
			entitlements: policy(() =>
				Promise.resolve({ accepted: false, reason: ' That code has expired. ' })
			),
		});

		const response = await ask(request, { code: 'K7QM-2XRD' });

		expect(await response.json()).toEqual({
			accepted: false,
			reason: 'That code has expired.',
		});
	});

	it.each([
		['none', undefined],
		['blank', '   '],
		['too long', 'x'.repeat(201)],
		['not plain text', 'Expired\u0007'],
	])('drops a reason that is %s, and still refuses', async (_name, reason) => {
		const { request } = buildApp({
			entitlements: policy(() => Promise.resolve({ accepted: false, reason })),
		});

		const response = await ask(request, { code: 'K7QM-2XRD' });

		expect(await response.json()).toEqual({ accepted: false });
	});

	it('keeps a code a day at most, and rounds a fraction of a second up', async () => {
		const answers = [
			{ accepted: true, expiresIn: 30 * 86_400 },
			{ accepted: true, expiresIn: 0.2 },
		];
		const { request } = buildApp({
			entitlements: policy(() => Promise.resolve(answers.shift())),
		});

		expect(await (await ask(request, { code: 'A' })).json()).toEqual({
			accepted: true,
			expiresIn: 86_400,
		});
		expect(await (await ask(request, { code: 'A' })).json()).toEqual({
			accepted: true,
			expiresIn: 1,
		});
	});

	it.each([
		['no hold', { accepted: true }],
		['a hold of nothing', { accepted: true, expiresIn: 0 }],
		['no verdict', { expiresIn: 60 }],
		['nothing', undefined],
	])('answers 500 for a policy that says %s', async (_name, answer) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { request } = buildApp({ entitlements: policy(() => Promise.resolve(answer)) });

		const response = await ask(request, { code: 'K7QM-2XRD' });

		expect(response.status).toBe(500);
		expect(error).toHaveBeenCalled();
	});

	it('answers 500 for a policy that throws, and logs it without the code', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { request } = buildApp({
			entitlements: policy(() => Promise.reject(new Error('D1 is down'))),
		});

		const response = await ask(request, { code: 'K7QM-2XRD' });

		expect(response.status).toBe(500);
		const logged = error.mock.calls.flat().join(' ');
		expect(logged).toContain('the code check failed: Error: D1 is down');
		expect(logged).not.toContain('K7QM-2XRD');
	});

	it('is only for a page on this origin', async () => {
		const entitlements = policy(() => Promise.resolve({ accepted: true, expiresIn: 60 }));
		const { request } = buildApp({ entitlements });

		const response = await ask(
			request,
			{ code: 'K7QM-2XRD' },
			{ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
		);

		expect(response.status).toBe(403);
		expect(entitlements.checkCode).not.toHaveBeenCalled();
	});

	it('is throttled per address before the policy is asked', async () => {
		const keys: string[] = [];
		const rateLimiter: RateLimiter = {
			check: (key) => {
				keys.push(key);
				return Promise.resolve({ allowed: false, retryAfter: 60 });
			},
		};
		const entitlements = policy(() => Promise.resolve({ accepted: true, expiresIn: 60 }));
		const { request } = buildApp({ entitlements, rateLimiter });

		const response = await ask(
			request,
			{ code: 'K7QM-2XRD' },
			{ 'cf-connecting-ip': '203.0.113.9' }
		);

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
		expect(keys).toEqual(['connect-code:203.0.113.9']);
		expect(entitlements.checkCode).not.toHaveBeenCalled();
	});

	it.each([
		['missing', {}],
		['blank', { code: '   ' }],
		['too long', { code: 'A'.repeat(65) }],
		['not printable', { code: 'K7QM\u0000' }],
		['not a string', { code: 42 }],
	])('refuses a code that is %s without asking the policy', async (_name, body) => {
		const entitlements = policy(() => Promise.resolve({ accepted: true, expiresIn: 60 }));
		const { request } = buildApp({ entitlements });

		const response = await ask(request, body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_request' });
		expect(entitlements.checkCode).not.toHaveBeenCalled();
	});

	it('is not there where the gate asks for no code', async () => {
		const { request } = buildApp({
			entitlements: {
				...alwaysAllowed,
				gate: { message: GATE.message, action: GATE.action },
			},
		});

		const response = await ask(request, { code: 'K7QM-2XRD' });

		expect(response.status).toBe(404);
	});

	it('is not there on an instance with no gate', async () => {
		const { request } = buildApp();

		expect((await ask(request, { code: 'K7QM-2XRD' })).status).toBe(404);
	});
});
