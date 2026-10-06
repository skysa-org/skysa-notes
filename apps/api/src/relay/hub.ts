import { logFailure } from '../log.js';

/**
 * The change relay's seam (docs/ARCHITECTURE.md §6, "Change relay").
 *
 * A device that has pushed says so on a WebSocket, and the connection's other
 * devices are told to pull. What carries the sockets and fans the message out
 * depends on where the app runs, so the routes see only this; `src/worker.ts`
 * passes the Durable Object hub, and a deployment that wants its fan-out
 * somewhere else passes its own.
 *
 * Optional. With no hub there is no relay: `/api/config` does not offer one and
 * its routes answer 404.
 */

/** Who a socket belongs to, decided by the routes before the hub sees it. */
export interface RelayMember {
	readonly connectionId: string;
	readonly grantId: string;
	/**
	 * When the socket has to go, in epoch milliseconds. The hub closes it with
	 * `RELAY_CLOSE.expired` the next time it would send or receive past this, and
	 * the device asks for a new ticket — which is when the grant is checked again.
	 */
	readonly until: number;
}

export interface RelayHub {
	/**
	 * Accept a WebSocket upgrade the routes have already authorized, and answer
	 * it (a `101`, on a runtime that has them).
	 */
	readonly connect: (request: Request, member: RelayMember) => Promise<Response>;
	/**
	 * Close the sockets of these grants, or of every device on the connection
	 * when no list is given, with `RELAY_CLOSE.revoked`.
	 */
	readonly revoke: (connectionId: string, grantIds?: readonly string[]) => Promise<void>;
}

/** How long a socket lives before it has to come back with a new ticket. */
export const RELAY_SOCKET_MS = 60 * 60 * 1000;

/**
 * Close codes the client acts on. In the 4000–4999 range RFC 6455 §7.4.2
 * leaves to applications.
 */
export const RELAY_CLOSE = {
	/** Past `until`: reconnect with a new ticket. */
	expired: 4001,
	/** The grant was revoked or the connection disconnected: do not reconnect. */
	revoked: 4003,
} as const;

/**
 * Tell the hub a grant has gone. Best effort: the database is what decides who
 * may connect, and it has already been written — a hub that could not be
 * reached leaves a socket that hears "changed" until it expires, and must not
 * turn a revoke the user asked for into a failure.
 */
export const closeSockets = async (
	hub: RelayHub | undefined,
	connectionId: string,
	grantIds?: readonly string[]
): Promise<void> => {
	if (hub === undefined || grantIds?.length === 0) return;
	await Promise.resolve()
		.then(() => hub.revoke(connectionId, grantIds))
		.catch((error: unknown) => {
			logFailure('closing relay sockets failed', error);
		});
};
