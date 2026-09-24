import { alwaysAllowed, type ConnectGate } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { buildApp, testConfig } from './harness.js';

/**
 * The connect gate: what an operator's policy tells the app to show where the
 * provider buttons are, served from `/api/config` and checked when the app is
 * built (docs/ARCHITECTURE.md §6, "Entitlement seam").
 */

const GATE: ConnectGate = {
	message: 'Sync on this server is part of the paid plan.',
	action: { label: 'See plans', url: 'https://example.com/plans' },
};

const gated = (gate: unknown) => ({ ...alwaysAllowed, gate: gate as ConnectGate });

const build = (gate: unknown) => () =>
	createApp({ config: testConfig(), entitlements: gated(gate) });

describe('the connect gate', () => {
	it('is not in the config of an instance without one, which reads exactly as before', async () => {
		const app = buildApp();

		const response = await app.request('/api/config');

		expect(await response.json()).toEqual({
			authMode: 'storage-first',
			providers: ['dropbox'],
		});
	});

	it('is served from the config when the policy has one', async () => {
		const app = buildApp({ entitlements: gated(GATE) });

		const response = await app.request('/api/config');

		expect(await response.json()).toEqual({
			authMode: 'storage-first',
			providers: ['dropbox'],
			connectGate: GATE,
		});
	});

	it('is served trimmed', async () => {
		const app = buildApp({
			entitlements: gated({
				message: '  Ask for access.\n',
				action: { label: ' Ask ', url: 'https://example.com/ask' },
			}),
		});

		const response = await app.request('/api/config');

		expect(await response.json()).toMatchObject({
			connectGate: {
				message: 'Ask for access.',
				action: { label: 'Ask', url: 'https://example.com/ask' },
			},
		});
	});

	it.each([
		['without an action', { message: GATE.message }, /action/],
		['without a message', { action: GATE.action }, /message/],
		['with an action missing its URL', { ...GATE, action: { label: 'Go' } }, /action\.url/],
		['with a blank message', { ...GATE, message: '   ' }, /message: must not be blank/],
		[
			'with a message too long',
			{ ...GATE, message: 'x'.repeat(501) },
			/message: must be at most/,
		],
		[
			'with a label too long',
			{ ...GATE, action: { ...GATE.action, label: 'x'.repeat(41) } },
			/label/,
		],
		[
			'linking over http',
			{ ...GATE, action: { ...GATE.action, url: 'http://example.com/' } },
			/https/,
		],
		[
			'linking to script',
			{ ...GATE, action: { ...GATE.action, url: 'javascript:alert(1)' } },
			/https/,
		],
		['linking relatively', { ...GATE, action: { ...GATE.action, url: '/plans' } }, /https/],
	])('stops the app being built %s', (_, gate, problem) => {
		expect(build(gate)).toThrow(problem);
	});

	it('names the field it refused, and does not repeat the value', () => {
		let message = '';
		try {
			build({
				...GATE,
				action: { ...GATE.action, url: 'http://example.com/?token=abc123' },
			})();
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toMatch(/^Invalid connect gate:\n {2}action\.url: /);
		expect(message).not.toContain('abc123');
	});
});
