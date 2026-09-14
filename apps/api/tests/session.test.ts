import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import { SESSION_DAYS } from '../src/session.js';
import { buildApp } from './harness.js';

describe('the session cookie', () => {
	it('is httpOnly, secure and lax, and lasts as long as the row', async () => {
		const app = buildApp();
		const { callback } = await app.connect();

		const cookie = callback.headers.getSetCookie().find((c) => c.startsWith('skysa_session='));
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain(`Max-Age=${String(SESSION_DAYS * 86400)}`);
	});

	it('carries an opaque id, not anything about the user', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const id = jar.get('skysa_session') ?? '';
		expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(id).not.toContain('user@example.com');
	});

	it('stops working once the row has expired', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(200);

		await createDb(app.db)
			.update(schema.sessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(schema.sessions.id, jar.get('skysa_session') ?? ''));

		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(401);
	});

	it('treats an id that names no row as no session at all', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		jar.set('skysa_session', 'made-up');

		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(401);
	});

	it('goes away with the user when the user goes away', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const drizzle = createDb(app.db);

		// The cascade is what keeps orphaned sessions from outliving an account.
		await drizzle.delete(schema.users);
		expect(await drizzle.select().from(schema.sessions)).toHaveLength(0);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(0);
		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(401);
	});
});
