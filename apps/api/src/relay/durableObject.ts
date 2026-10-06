import { RELAY_PING, RELAY_PONG } from '@skysa/core';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

import type { RelayHub, RelayMember } from './hub.js';
import { onFrame, onRevoke, type RoomSocket, type Seat } from './room.js';

/**
 * The change relay's hub on Cloudflare: one Durable Object per connection,
 * addressed by the connection's id, holding that connection's sockets
 * (docs/ARCHITECTURE.md §6, "Change relay").
 *
 * On the WebSocket Hibernation API, so an open socket with nothing to say costs
 * no duration: the object is evicted between frames and its sockets stay with
 * the runtime, each carrying its `Seat` as an attachment. A `ping` is answered
 * `pong` by the runtime without waking it at all.
 * https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 *
 * It stores nothing. The SQLite backend it is declared with in `wrangler.toml`
 * is what a new class gets, and on Workers Free the only one there is.
 */

/**
 * How the Worker tells the object who a socket belongs to. Set by the hub after
 * the routes have authorized the upgrade, over whatever a client sent under the
 * same name — and the object is reachable only through the Worker.
 */
const MEMBER_HEADER = 'x-skysa-relay-member';

const memberSchema = z.object({
	connectionId: z.string().min(1),
	grantId: z.string().min(1),
	until: z.number().int(),
});

const seatSchema = z.object({
	grantId: z.string(),
	until: z.number(),
	lastPushedAt: z.number(),
});

const memberFrom = (header: string | null): RelayMember | undefined => {
	if (header === null) return undefined;
	try {
		const parsed = memberSchema.safeParse(JSON.parse(header));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

/**
 * A runtime socket as the room sees it. A socket whose attachment cannot be
 * read is not one this object accepted, and is given a seat that is already
 * past its time, so the room closes it rather than trusting it.
 */
const roomSocket = (ws: WebSocket): RoomSocket => {
	const parsed = seatSchema.safeParse(ws.deserializeAttachment());
	return {
		seat: parsed.success ? parsed.data : { grantId: '', until: 0, lastPushedAt: 0 },
		reseat: (seat: Seat) => {
			ws.serializeAttachment(seat);
		},
		// A socket can be closing while the room sends to it; that is its own
		// business, not a reason to stop telling the rest.
		send: (text) => {
			try {
				ws.send(text);
			} catch {
				// Gone already.
			}
		},
		close: (code, reason) => {
			try {
				ws.close(code, reason);
			} catch {
				// Gone already.
			}
		},
	};
};

export class ConnectionRelay extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG));
	}

	/** The upgrade, already authorized by `GET /api/relay`. */
	override fetch(request: Request): Response {
		const member = memberFrom(request.headers.get(MEMBER_HEADER));
		if (member === undefined || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 400 });
		}

		const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
		// Tagged with the grant, so a revoke finds a device's sockets without
		// reading every attachment.
		this.ctx.acceptWebSocket(server, [member.grantId]);
		server.serializeAttachment({
			grantId: member.grantId,
			until: member.until,
			lastPushedAt: 0,
		} satisfies Seat);

		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		onFrame(roomSocket(ws), message, this.ctx.getWebSockets().map(roomSocket), Date.now());
	}

	/**
	 * Finish the closing handshake the device started. A runtime that has
	 * already answered it makes this a no-op, which `roomSocket.close` absorbs.
	 */
	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		roomSocket(ws).close(code === 1005 || code === 1006 ? 1000 : code, reason);
	}

	/** RPC from `durableObjectRelay`'s `revoke`. */
	revoke(grantIds?: readonly string[]): void {
		const sockets =
			grantIds === undefined
				? this.ctx.getWebSockets()
				: grantIds.flatMap((grantId) => this.ctx.getWebSockets(grantId));
		onRevoke(sockets.map(roomSocket), grantIds);
	}
}

/** The `RelayHub` `src/worker.ts` passes `createApp` when `RELAY=true`. */
export const durableObjectRelay = (
	namespace: DurableObjectNamespace<ConnectionRelay>
): RelayHub => {
	const stubFor = (connectionId: string) => namespace.get(namespace.idFromName(connectionId));

	return {
		connect: (request, member) => {
			const headers = new Headers(request.headers);
			headers.set(MEMBER_HEADER, JSON.stringify(member));
			return stubFor(member.connectionId).fetch(new Request(request, { headers }));
		},
		revoke: async (connectionId, grantIds) => {
			await stubFor(connectionId).revoke(grantIds);
		},
	};
};
