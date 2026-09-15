import { describe, expect, it, vi } from 'vitest';

import { buildApp, cookieNames } from './harness.js';

/**
 * What reaches the Worker log. `CLAUDE.md` and docs/PLAN.md §6 both say secrets
 * never do, and the failure mode is quiet: an error object that looks harmless
 * carries the failing query's bound parameters, which are session ids and
 * secret ciphertext.
 */

describe('the error log', () => {
	it('does not carry the parameters of a failed query', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		// Drop `sessions`, so the query that fails is the one that binds the
		// session id — a live credential — as a parameter. Dropping `connections`
		// instead would make the assertion below pass no matter what was logged.
		await app.db.prepare('DROP TABLE sessions').run();

		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await app.request('/api/connections', { cookies: jar });
		const lines = logged.mock.calls.map((call) =>
			call
				.map((arg) =>
					JSON.stringify(arg, (_key, value) =>
						// An Error serializes to `{}` unless its message is pulled out
						// explicitly, and the message is the half that leaks.
						value instanceof Error
							? { ...value, text: value.message }
							: (value as unknown)
					)
				)
				.join(' ')
		);
		logged.mockRestore();

		expect(response.status).toBe(500);
		expect(lines.join('\n')).not.toBe('');
		// The session id is a live credential, and it is bound into the query that
		// just failed.
		expect(lines.join('\n')).not.toContain(jar.get(cookieNames.session) ?? 'unreachable');
		expect(lines.join('\n')).not.toContain('params:');
	});
});
