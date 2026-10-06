import { RELAY_CHANGED as CHANGED, RELAY_CLOSE } from '@skysa/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionRelay, durableObjectRelay } from '../src/relay/durableObject.js';
import { type RelayMember } from '../src/relay/hub.js';

/**
 * The Durable Object hub, against a stand-in for the runtime: Node has no
 * `WebSocketPair`, no hibernatable sockets and no `101`. What these pin is the
 * object's half — what it accepts, what it tags and attaches, and how it maps
 * the runtime's sockets onto the room. Whether the runtime behaves as stood in
 * for here is the live check's question (docs/self-hosting.md).
 */

interface FakeSocket {
	readonly name: string;
	attachment: unknown;
	readonly sent: string[];
	readonly closed: { code: number; reason: string }[];
	failSend?: boolean;
	failClose?: boolean;
	serializeAttachment: (value: unknown) => void;
	deserializeAttachment: () => unknown;
	send: (text: string) => void;
	close: (code: number, reason: string) => void;
}

const fakeSocket = (name: string): FakeSocket => {
	const ws: FakeSocket = {
		name,
		attachment: null,
		sent: [],
		closed: [],
		serializeAttachment: (value) => {
			ws.attachment = structuredClone(value);
		},
		deserializeAttachment: () => ws.attachment,
		send: (text) => {
			if (ws.failSend === true) throw new Error('closing');
			ws.sent.push(text);
		},
		close: (code, reason) => {
			if (ws.failClose === true) throw new Error('already closed');
			ws.closed.push({ code, reason });
		},
	};
	return ws;
};

const fakeState = () => {
	const accepted: { ws: FakeSocket; tags: string[] }[] = [];
	const autoResponse: { request?: string; response?: string } = {};
	const state = {
		acceptWebSocket: (ws: FakeSocket, tags: string[]) => {
			accepted.push({ ws, tags });
		},
		getWebSockets: (tag?: string) =>
			accepted
				.filter((entry) => tag === undefined || entry.tags.includes(tag))
				.map((e) => e.ws),
		setWebSocketAutoResponse: (pair: { request: string; response: string }) => {
			autoResponse.request = pair.request;
			autoResponse.response = pair.response;
		},
	};
	return { state, accepted, autoResponse };
};

/** Every pair the object makes, client first. */
const pairs: [FakeSocket, FakeSocket][] = [];

beforeEach(() => {
	pairs.length = 0;
	vi.stubGlobal(
		'WebSocketPair',
		class {
			constructor() {
				const pair: [FakeSocket, FakeSocket] = [
					fakeSocket(`client${String(pairs.length)}`),
					fakeSocket(`server${String(pairs.length)}`),
				];
				pairs.push(pair);
				return { 0: pair[0], 1: pair[1] };
			}
		}
	);
	vi.stubGlobal(
		'WebSocketRequestResponsePair',
		class {
			constructor(request: string, response: string) {
				return { request, response };
			}
		}
	);
	// Node will not make a `101`, nor carry a `webSocket`.
	vi.stubGlobal(
		'Response',
		class {
			constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
				return { status: init?.status ?? 200, webSocket: init?.webSocket };
			}
		}
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const MEMBER_HEADER = 'x-skysa-relay-member';
const HOUR = 60 * 60 * 1000;

const relayObject = () => {
	const fake = fakeState();
	const relay = new ConnectionRelay(
		fake.state as unknown as DurableObjectState,
		{} as Cloudflare.Env
	);
	return { relay, ...fake };
};

const upgradeFor = (member: Partial<RelayMember> | string | undefined, upgrade = 'websocket') =>
	new Request('https://notes.example.com/api/relay', {
		headers: {
			upgrade,
			...(member === undefined
				? {}
				: {
						[MEMBER_HEADER]:
							typeof member === 'string' ? member : JSON.stringify(member),
					}),
		},
	});

const join = (relay: ConnectionRelay, grantId: string, until = Date.now() + HOUR) => {
	const response = relay.fetch(upgradeFor({ connectionId: 'c1', grantId, until })) as unknown as {
		status: number;
		webSocket: FakeSocket;
	};
	const server = pairs.at(-1)?.[1];
	if (server === undefined) throw new Error('no socket was made');
	return { response, server };
};

describe('ConnectionRelay', () => {
	it('answers a ping without waking: the runtime does it', () => {
		const { autoResponse } = relayObject();
		expect(autoResponse).toEqual({ request: 'ping', response: 'pong' });
	});

	it('accepts an authorized upgrade, tagged with its grant, seated until its hour', () => {
		const { relay, accepted } = relayObject();
		const until = Date.now() + HOUR;

		const { response, server } = join(relay, 'phone', until);

		expect(response.status).toBe(101);
		expect(response.webSocket).toBe(pairs[0]?.[0]);
		expect(accepted).toEqual([{ ws: server, tags: ['phone'] }]);
		expect(server.attachment).toEqual({ grantId: 'phone', until, lastPushedAt: 0 });
	});

	it('refuses what the Worker did not authorize, and what is not an upgrade', () => {
		const { relay, accepted } = relayObject();
		const good = { connectionId: 'c1', grantId: 'phone', until: Date.now() + HOUR };

		for (const request of [
			upgradeFor(undefined),
			upgradeFor('not json'),
			upgradeFor({ connectionId: 'c1', grantId: '', until: 1 }),
			upgradeFor({ connectionId: 'c1', grantId: 'phone' }),
			upgradeFor(good, 'h2c'),
		]) {
			expect((relay.fetch(request) as unknown as { status: number }).status).toBe(400);
		}
		expect(accepted).toEqual([]);
	});

	it('tells the connection’s other devices when one has pushed, and remembers when', () => {
		const { relay } = relayObject();
		const phone = join(relay, 'phone').server;
		const laptop = join(relay, 'laptop').server;

		relay.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ t: 'pushed' }));

		expect(laptop.sent).toEqual([CHANGED]);
		expect(phone.sent).toEqual([]);
		// Kept on the socket, where it survives the object being evicted.
		expect((phone.attachment as { lastPushedAt: number }).lastPushedAt).toBeGreaterThan(0);
	});

	it('goes on telling the rest when one of them is already closing', () => {
		const { relay } = relayObject();
		const phone = join(relay, 'phone').server;
		const going = join(relay, 'tablet').server;
		const laptop = join(relay, 'laptop').server;
		going.failSend = true;

		relay.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ t: 'pushed' }));

		expect(laptop.sent).toEqual([CHANGED]);
	});

	it('closes a socket it cannot read the seat of, rather than trusting it', () => {
		const { relay } = relayObject();
		const odd = join(relay, 'phone').server;
		const laptop = join(relay, 'laptop').server;
		odd.attachment = { something: 'else' };

		relay.webSocketMessage(odd as unknown as WebSocket, JSON.stringify({ t: 'pushed' }));

		expect(odd.closed).toEqual([{ code: RELAY_CLOSE.expired, reason: 'expired' }]);
		expect(laptop.sent).toEqual([]);
	});

	it('closes the sockets of revoked grants, or all of them', () => {
		const { relay } = relayObject();
		const phone = join(relay, 'phone').server;
		const laptop = join(relay, 'laptop').server;

		relay.revoke(['phone']);
		expect(phone.closed).toEqual([{ code: RELAY_CLOSE.revoked, reason: 'revoked' }]);
		expect(laptop.closed).toEqual([]);

		relay.revoke();
		expect(laptop.closed).toEqual([{ code: RELAY_CLOSE.revoked, reason: 'revoked' }]);
	});

	it('finishes a closing handshake the device started, with a code it may send', () => {
		const { relay } = relayObject();
		const phone = join(relay, 'phone').server;
		const laptop = join(relay, 'laptop').server;
		const tablet = join(relay, 'tablet').server;
		tablet.failClose = true;

		relay.webSocketClose(phone as unknown as WebSocket, 1001, 'going away');
		// 1005 and 1006 say no code was given; neither may be sent back.
		relay.webSocketClose(laptop as unknown as WebSocket, 1005, '');
		expect(() => {
			relay.webSocketClose(tablet as unknown as WebSocket, 1000, '');
		}).not.toThrow();

		expect(phone.closed).toEqual([{ code: 1001, reason: 'going away' }]);
		expect(laptop.closed).toEqual([{ code: 1000, reason: '' }]);
	});
});

describe('durableObjectRelay', () => {
	const fakeNamespace = () => {
		const fetched: { id: string; request: Request }[] = [];
		const revoked: { id: string; grantIds: readonly string[] | undefined }[] = [];
		const namespace = {
			idFromName: (name: string) => `id:${name}`,
			get: (id: string) => ({
				fetch: (request: Request) => {
					fetched.push({ id, request });
					return Promise.resolve({ status: 101 });
				},
				revoke: (grantIds?: readonly string[]) => {
					revoked.push({ id, grantIds });
					return Promise.resolve();
				},
			}),
		};
		return {
			hub: durableObjectRelay(
				namespace as unknown as DurableObjectNamespace<ConnectionRelay>
			),
			fetched,
			revoked,
		};
	};

	it('sends an upgrade to its connection’s object, saying who it belongs to', async () => {
		const { hub, fetched } = fakeNamespace();
		const member = { connectionId: 'c1', grantId: 'phone', until: 5 };
		const request = new Request('https://notes.example.com/api/relay', {
			// A client naming itself someone else gets overwritten, not believed.
			headers: { upgrade: 'websocket', [MEMBER_HEADER]: '{"grantId":"laptop"}' },
		});

		await hub.connect(request, member);

		expect(fetched).toHaveLength(1);
		expect(fetched[0]?.id).toBe('id:c1');
		expect(fetched[0]?.request.headers.get('upgrade')).toBe('websocket');
		expect(JSON.parse(fetched[0]?.request.headers.get(MEMBER_HEADER) ?? '')).toEqual(member);
	});

	it('takes a revoke to the connection’s object', async () => {
		const { hub, revoked } = fakeNamespace();

		await hub.revoke('c1', ['phone']);
		await hub.revoke('c2');

		expect(revoked).toEqual([
			{ id: 'id:c1', grantIds: ['phone'] },
			{ id: 'id:c2', grantIds: undefined },
		]);
	});
});
