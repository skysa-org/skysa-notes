import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import { SESSION_DAYS } from '../src/session.js';
import { buildApp, cookieNames } from './harness.js';

describe('the session cookie', () => {
	it('is httpOnly, secure and lax, and lasts as long as the row', async () => {
		const app = buildApp();
		const { callback } = await app.connect();

		const cookie = callback.headers
			.getSetCookie()
			.find((c) => c.startsWith(`${cookieNames.session}=`));
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain(`Max-Age=${String(SESSION_DAYS * 86400)}`);
	});

	it('carries an opaque id, not anything about the user', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const id = jar.get(cookieNames.session) ?? '';
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
			.where(eq(schema.sessions.id, jar.get(cookieNames.session) ?? ''));

		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(401);
	});

	it('treats an id that names no row as no session at all', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		jar.set(cookieNames.session, 'made-up');

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

describe('what the first draft got wrong', () => {
	it('slides the 90-day window instead of expiring 90 days after the first connect', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const drizzle = createDb(app.db);

		// Two days in. docs/PLAN.md §6 calls the window sliding; without a write
		// on the read path it was fixed, and every user was logged out on day 90
		// no matter how much they used the app.
		const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
		await drizzle
			.update(schema.sessions)
			.set({ expiresAt: new Date(twoDaysAgo + SESSION_DAYS * 24 * 60 * 60 * 1000) })
			.where(eq(schema.sessions.id, jar.get(cookieNames.session) ?? ''));
		const [before] = await drizzle.select().from(schema.sessions);

		jar.absorb(await app.request('/api/connections', { cookies: jar }));

		const [after] = await drizzle.select().from(schema.sessions);
		expect(after?.expiresAt.getTime()).toBeGreaterThan(before?.expiresAt.getTime() ?? 0);
	});

	it('does not write to the database on every read', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const drizzle = createDb(app.db);
		const [before] = await drizzle.select().from(schema.sessions);

		await app.request('/api/connections', { cookies: jar });
		await app.request('/api/connections', { cookies: jar });

		// A session issued moments ago has nothing to slide, and a read path that
		// writes on every request is a read path that fails on every request.
		const [after] = await drizzle.select().from(schema.sessions);
		expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
	});

	it('carries the __Host- prefix, so no sibling subdomain can set it', async () => {
		const app = buildApp();
		const { callback } = await app.connect();

		const cookie = callback.headers
			.getSetCookie()
			.find((c) => c.startsWith(`${cookieNames.session}=`));
		expect(cookieNames.session).toBe('__Host-skysa_session');
		expect(cookie).toContain('Path=/');
		expect(cookie).not.toContain('Domain=');
	});
});
