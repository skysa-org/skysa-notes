import { describe, expect, it, vi } from 'vitest';

import { hashCredential } from '../src/credentials.js';
import { buildApp } from './harness.js';

/**
 * What reaches the Worker log. `CLAUDE.md` and docs/ARCHITECTURE.md §6 both say secrets
 * never do, and the failure mode is quiet: an error object that looks harmless
 * carries the failing query's bound parameters, which are credential hashes and
 * secret ciphertext.
 */

describe('the error log', () => {
	it('does not carry the parameters of a failed query', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const hash = await hashCredential(credential);

		// Drop `grants`, so the query that fails is the one that binds the
		// credential hash — the lookup key for a live credential — as a parameter.
		// Dropping `storage_connections` instead would make the assertion below
		// pass no matter what was logged.
		await app.db.prepare('DROP TABLE grants').run();

		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await app.request('/api/connection', { credential });
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
		// The hash reaches the connection, and it is bound into the query that
		// just failed. So is the credential, if anything ever logged the header.
		expect(lines.join('\n')).not.toContain(hash);
		expect(lines.join('\n')).not.toContain(credential);
		expect(lines.join('\n')).not.toContain('params:');
	});
});
