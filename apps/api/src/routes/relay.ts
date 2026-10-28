import { Hono } from 'hono';

import type { AppEnv, RouteDeps } from '../context.js';
import { liveGrant } from '../credentials.js';
import { fail, requireBearer, requireSameOrigin, tooMany } from '../http.js';
import { RELAY_SOCKET_MS } from '../relay/hub.js';
import { issueTicket, readTicket, TICKET_SECONDS } from '../relay/ticket.js';

/**
 * The change relay's two routes (docs/ARCHITECTURE.md §6, "Change relay"): a
 * ticket asked for with the bearer, and the WebSocket upgrade it opens.
 *
 * The upgrade is outside `/connection*` on purpose: a browser cannot send
 * `Authorization` on a WebSocket, so behind `requireBearer` every upgrade
 * would be a 401. It checks for itself instead, and
 * in an order where the cheap refusals come first and nothing reaches the hub
 * that the database has not just agreed to.
 *
 * Both answer 404 where the deployment runs no hub, to a page of its own. The
 * upgrade refuses another origin first, 403, so such a page learns nothing of
 * whether there is one.
 */
export const relayRoutes = (deps: RouteDeps) => {
	const { config, rateLimiter, relay, keys } = deps;
	const app = new Hono<AppEnv>();
	/** Refuses a request from any page but this deployment's own. */
	const ownOrigin = requireSameOrigin(config.appOrigin);

	app.post('/connection/relay/ticket', requireBearer, async (c) => {
		if (relay === undefined) return fail(c, 'relay_disabled', 404);
		const { connection, grant } = c.get('bearer');

		const limit = await rateLimiter.check(`relay-ticket:${connection.id}`);
		if (!limit.allowed) return tooMany(c, limit.retryAfter);

		const ticket = await issueTicket(
			(await keys()).ticketKey,
			{ grantId: grant.id, connectionId: connection.id },
			Date.now()
		);
		return c.json({ ticket, expiresIn: TICKET_SECONDS });
	});

	// A page on another origin can open a WebSocket here, and the browser sends
	// no preflight for one; `Origin` is how a server tells.
	app.get('/relay', ownOrigin, async (c) => {
		if (relay === undefined) return fail(c, 'relay_disabled', 404);
		if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
			return fail(c, 'upgrade_required', 426);
		}
		const now = Date.now();
		const holder = await readTicket((await keys()).ticketKey, c.req.query('ticket'), now);
		if (holder === undefined) return fail(c, 'ticket_invalid', 401);

		// The ticket says who it was given to, not whether they still may: a
		// device revoked in the seconds since, or idle past its expiry, is refused
		// here as `requireBearer` would refuse it.
		if (!(await liveGrant(c.get('db'), holder.grantId, holder.connectionId, now))) {
			return fail(c, 'credential_revoked', 401);
		}

		const limit = await rateLimiter.check(`relay:${holder.connectionId}`);
		if (!limit.allowed) return tooMany(c, limit.retryAfter);

		// Without its query: the hub has no use for the ticket, and what it never
		// holds it cannot put in a log or an error message.
		const { origin, pathname } = new URL(c.req.url);
		return relay.connect(new Request(`${origin}${pathname}`, c.req.raw), {
			...holder,
			until: now + RELAY_SOCKET_MS,
		});
	});

	return app;
};
