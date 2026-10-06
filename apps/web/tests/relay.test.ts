import { RELAY_CHANGED, RELAY_CLOSE, RELAY_PING, RELAY_PONG, RELAY_PUSHED } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError, type InstanceConfig } from '../src/api/client.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	createRelayFactory,
	createRelayLink,
	type OpenRelaySocket,
	RELAY_MAX_RETRY_MS,
	RELAY_PING_MS,
	RELAY_PONG_MS,
	RELAY_RETRY_MS,
	RELAY_TELL_MS,
	type RelayEnvironment,
	type RelayLinkOptions,
	type RelaySocketEvents,
	relayUrl,
	type TicketAnswer,
} from '../src/sync/relay.js';

/**
 * The change relay's socket, from the app's side (docs/ARCHITECTURE.md §6,
 * "Change relay"), against a stand-in for the browser's `WebSocket` and for
 * time, the network and the tab.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map(async (cleanup) => {
			await cleanup();
		})
	);
});

type RelayEvent = Parameters<RelayEnvironment['listen']>[0];

const fakeEnvironment = () => {
	const state = { now: 1_000_000, online: true, visible: true, nextId: 0 };
	const handlers = new Map<RelayEvent, Set<() => void>>();
	const timers = new Map<number, { at: number; callback: () => void }>();

	const environment: RelayEnvironment = {
		now: () => state.now,
		isOnline: () => state.online,
		isVisible: () => state.visible,
		listen: (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		setTimer: (callback, ms) => {
			state.nextId += 1;
			const id = state.nextId;
			timers.set(id, { at: state.now + ms, callback });
			return () => {
				timers.delete(id);
			};
		},
	};

	return {
		environment,
		state,
		listening: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
		/** Hidden or shown, offline or online, and the event that says so. */
		set: (change: { visible?: boolean; online?: boolean }) => {
			if (change.visible !== undefined) {
				state.visible = change.visible;
				handlers.get('visibilitychange')?.forEach((handler) => {
					handler();
				});
			}
			if (change.online !== undefined) {
				state.online = change.online;
				handlers.get(change.online ? 'online' : 'offline')?.forEach((handler) => {
					handler();
				});
			}
		},
		/** Move the clock on, running every timer that comes due on the way. */
		advance: (ms: number) => {
			state.now += ms;
			[...timers.entries()]
				.filter(([, timer]) => timer.at <= state.now)
				.sort(([, a], [, b]) => a.at - b.at)
				.forEach(([id, timer]) => {
					timers.delete(id);
					timer.callback();
				});
		},
		/** How far away each pending timer is. */
		pending: () =>
			[...timers.values()].map((timer) => timer.at - state.now).sort((a, b) => a - b),
	};
};

interface FakeSocket {
	readonly url: string;
	readonly events: RelaySocketEvents;
	readonly sent: string[];
	closes: number;
}

const fakeSockets = () => {
	const sockets: FakeSocket[] = [];
	const open = vi.fn<OpenRelaySocket>((url, events) => {
		const socket: FakeSocket = { url, events, sent: [], closes: 0 };
		sockets.push(socket);
		return {
			send: (text) => {
				socket.sent.push(text);
			},
			close: () => {
				socket.closes += 1;
			},
		};
	});
	return {
		open,
		sockets,
		last: (): FakeSocket => {
			const socket = sockets.at(-1);
			if (socket === undefined) throw new Error('no socket was opened');
			return socket;
		},
	};
};

/** Long enough for a ticket that has been asked for to have come back. */
const settled = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});

/** Long enough for anything that reads the database to have done so. */
const quiet = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 60);
	});

const linked = (overrides: Partial<RelayLinkOptions> = {}) => {
	const env = fakeEnvironment();
	const sockets = fakeSockets();
	const issued = new Map<'count', number>([['count', 0]]);
	const ticket = vi.fn<() => Promise<TicketAnswer>>(() => {
		const count = (issued.get('count') ?? 0) + 1;
		issued.set('count', count);
		return Promise.resolve({ kind: 'ticket', ticket: `ticket${String(count)}` });
	});
	const onChanged = vi.fn();
	const link = createRelayLink({
		environment: env.environment,
		ticket,
		url: (value) => `wss://notes.example.com/api/relay?ticket=${value}`,
		open: sockets.open,
		onChanged,
		// The longest wait the backoff allows, so the test can say what it is.
		random: () => 1,
		...overrides,
	});
	cleanups.push(() => {
		link.close();
	});
	return { link, env, ticket, onChanged, ...sockets };
};

/** Opened, and answered once: a socket that works. */
const working = async (h: ReturnType<typeof linked>) => {
	await settled();
	const socket = h.last();
	socket.events.opened();
	socket.events.heard(RELAY_PONG);
	return socket;
};

describe('the relay link', () => {
	it('opens a socket with a fresh ticket, and asks at once whether it works', async () => {
		const h = linked();
		await settled();

		expect(h.ticket).toHaveBeenCalledTimes(1);
		expect(h.sockets.map((socket) => socket.url)).toEqual([
			'wss://notes.example.com/api/relay?ticket=ticket1',
		]);
		h.last().events.opened();
		expect(h.last().sent).toEqual([RELAY_PING]);
	});

	it('runs a round when another device has pushed', async () => {
		const h = linked();
		const socket = await working(h);

		socket.events.heard(RELAY_CHANGED);
		expect(h.onChanged).toHaveBeenCalledTimes(1);

		// From a newer relay than this app: nothing to do with it.
		socket.events.heard('{"t":"something new"}');
		expect(h.onChanged).toHaveBeenCalledTimes(1);
	});

	it('holds nothing open while the app is out of sight, and opens again when it is back', async () => {
		const h = linked();
		const socket = await working(h);

		h.env.set({ visible: false });
		expect(socket.closes).toBe(1);
		// Nothing waits to bring it back while hidden: no ping, no retry.
		expect(h.env.pending()).toEqual([]);

		h.env.set({ visible: true });
		await settled();
		expect(h.ticket).toHaveBeenCalledTimes(2);
		expect(h.sockets).toHaveLength(2);
	});

	it('waits on no retry while out of sight, and tries at once when back', async () => {
		const failing = new Map<'fail', boolean>([['fail', true]]);
		const h = linked({
			ticket: () =>
				failing.get('fail') === true
					? Promise.reject(new Error('down'))
					: Promise.resolve({ kind: 'ticket', ticket: 'up' }),
		});
		await settled();
		expect(h.env.pending()).toEqual([RELAY_RETRY_MS]);

		h.env.set({ visible: false });
		expect(h.env.pending()).toEqual([]);

		failing.set('fail', false);
		h.env.set({ visible: true });
		await settled();
		expect(h.sockets).toHaveLength(1);
	});

	it('asks for nothing while hidden or offline from the start', async () => {
		const hidden = linked({
			environment: { ...fakeEnvironment().environment, isVisible: () => false },
		});
		const offline = linked({
			environment: { ...fakeEnvironment().environment, isOnline: () => false },
		});
		await settled();

		expect(hidden.ticket).not.toHaveBeenCalled();
		expect(offline.ticket).not.toHaveBeenCalled();
	});

	it('lets go of the socket when the network goes, and comes back with it', async () => {
		const h = linked();
		const socket = await working(h);

		h.env.set({ online: false });
		expect(socket.closes).toBe(1);
		expect(h.env.pending()).toEqual([]);

		h.env.set({ online: true });
		await settled();
		expect(h.sockets).toHaveLength(2);
	});

	it('opens nothing with a ticket that arrives after the app went out of sight', async () => {
		const answer = new Map<'resolve', (value: TicketAnswer) => void>();
		const h = linked({
			ticket: () =>
				new Promise((resolve) => {
					answer.set('resolve', resolve);
				}),
		});

		h.env.set({ visible: false });
		answer.get('resolve')?.({ kind: 'ticket', ticket: 'late' });
		await settled();

		expect(h.sockets).toEqual([]);
	});

	it('opens one socket, with the newest ticket, when hidden and back while asking', async () => {
		const answers: ((value: TicketAnswer) => void)[] = [];
		const h = linked({
			ticket: () =>
				new Promise((resolve) => {
					answers.push(resolve);
				}),
		});

		h.env.set({ visible: false });
		h.env.set({ visible: true });
		answers[1]?.({ kind: 'ticket', ticket: 'second' });
		answers[0]?.({ kind: 'ticket', ticket: 'first' });
		await settled();

		expect(h.sockets.map((socket) => socket.url)).toEqual([
			'wss://notes.example.com/api/relay?ticket=second',
		]);
	});

	it('tries again after a failure, waiting twice as long each time, up to a minute', async () => {
		const h = linked({ ticket: () => Promise.reject(new Error('offline after all')) });
		const waits: number[] = [];

		for (const _attempt of Array.from({ length: 9 })) {
			await settled();
			waits.push(...h.env.pending());
			h.env.advance(Math.min(...h.env.pending()));
		}

		expect(waits).toEqual([
			RELAY_RETRY_MS,
			2 * RELAY_RETRY_MS,
			4 * RELAY_RETRY_MS,
			8 * RELAY_RETRY_MS,
			16 * RELAY_RETRY_MS,
			32 * RELAY_RETRY_MS,
			RELAY_MAX_RETRY_MS,
			RELAY_MAX_RETRY_MS,
			RELAY_MAX_RETRY_MS,
		]);
	});

	it('waits half the backoff at least, and the rest by chance', async () => {
		const h = linked({
			ticket: () => Promise.reject(new Error('down')),
			random: () => 0,
		});
		await settled();

		expect(h.env.pending()).toEqual([RELAY_RETRY_MS / 2]);
	});

	it('starts the backoff over once the relay has answered', async () => {
		const h = linked();
		await settled();
		// Refused at the upgrade, three times: never opened.
		for (const _attempt of [1, 2, 3]) {
			h.last().events.closed(1006);
			h.env.advance(Math.min(...h.env.pending()));
			await settled();
		}

		const socket = h.last();
		socket.events.opened();
		socket.events.heard(RELAY_PONG);
		socket.events.closed(1006);

		expect(h.env.pending()).toEqual([RELAY_RETRY_MS]);
	});

	it('comes back at once with a new ticket when its hour is up', async () => {
		const h = linked();
		const socket = await working(h);

		socket.events.closed(RELAY_CLOSE.expired);
		await settled();

		expect(h.ticket).toHaveBeenCalledTimes(2);
		expect(h.sockets).toHaveLength(2);
	});

	it('does not take an hour being up at its word from a socket that never worked', async () => {
		const h = linked();
		await settled();

		h.last().events.closed(RELAY_CLOSE.expired);
		await settled();

		expect(h.ticket).toHaveBeenCalledTimes(1);
		expect(h.env.pending()).toEqual([RELAY_RETRY_MS]);
	});

	it('stops for good when the device has been signed out', async () => {
		const h = linked();
		const socket = await working(h);

		socket.events.closed(RELAY_CLOSE.revoked);
		h.env.set({ visible: false });
		h.env.set({ visible: true });
		h.link.pushed();
		await settled();

		expect(h.ticket).toHaveBeenCalledTimes(1);
		expect(h.env.pending()).toEqual([]);
	});

	it('stops when there is nothing to connect to', async () => {
		const h = linked({ ticket: () => Promise.resolve({ kind: 'stop' }) });
		await settled();

		h.env.set({ online: false });
		h.env.set({ online: true });
		await settled();

		expect(h.sockets).toEqual([]);
		expect(h.env.pending()).toEqual([]);
	});

	it('gives up on a socket that stops answering, and opens another', async () => {
		const h = linked();
		const socket = await working(h);

		h.env.advance(RELAY_PING_MS);
		expect(socket.sent).toEqual([RELAY_PING, RELAY_PING]);
		socket.events.heard(RELAY_PONG);
		h.env.advance(RELAY_PING_MS);
		expect(socket.closes).toBe(0);

		// The third ping goes unanswered.
		h.env.advance(RELAY_PONG_MS);
		expect(socket.closes).toBe(1);
		h.env.advance(Math.min(...h.env.pending()));
		await settled();
		expect(h.sockets).toHaveLength(2);
	});

	it('hears nothing from a socket it has let go', async () => {
		const h = linked();
		const old = await working(h);
		h.env.set({ visible: false });
		h.env.set({ visible: true });
		await settled();

		old.events.heard(RELAY_CHANGED);
		old.events.closed(RELAY_CLOSE.revoked);
		h.last().events.opened();
		h.link.pushed();

		expect(h.onChanged).not.toHaveBeenCalled();
		// Not stopped by the old socket's close: the new one still tells.
		expect(h.last().sent).toEqual([RELAY_PING, RELAY_PUSHED]);
	});

	describe('telling the other devices', () => {
		it('says this device has pushed', async () => {
			const h = linked();
			const socket = await working(h);

			h.link.pushed();

			expect(socket.sent).toEqual([RELAY_PING, RELAY_PUSHED]);
		});

		it('says so once the socket is open, when it was pushed before', async () => {
			const h = linked();
			h.link.pushed();
			await settled();
			h.last().events.opened();

			expect(h.last().sent).toEqual([RELAY_PING, RELAY_PUSHED]);
		});

		it('says so once it is back in sight, when it was pushed while hidden', async () => {
			const h = linked();
			await working(h);
			h.env.set({ visible: false });
			h.link.pushed();

			h.env.set({ visible: true });
			await settled();
			h.last().events.opened();

			expect(h.last().sent).toEqual([RELAY_PING, RELAY_PUSHED]);
		});

		it('says it once, not again on every socket after', async () => {
			const h = linked();
			await working(h);
			h.link.pushed();
			h.env.advance(RELAY_TELL_MS);

			h.env.set({ visible: false });
			h.env.set({ visible: true });
			await settled();
			h.last().events.opened();
			h.env.advance(RELAY_TELL_MS);

			expect(h.last().sent).toEqual([RELAY_PING]);
		});

		it('spaces what it says, so the relay drops none of it, and says the last', async () => {
			const h = linked();
			const socket = await working(h);

			h.link.pushed();
			h.link.pushed();
			h.link.pushed();
			expect(socket.sent).toEqual([RELAY_PING, RELAY_PUSHED]);

			h.env.advance(RELAY_TELL_MS - 1);
			expect(socket.sent).toEqual([RELAY_PING, RELAY_PUSHED]);
			h.env.advance(1);
			// Once, for both: they ask the other devices for the same round.
			expect(socket.sent).toEqual([RELAY_PING, RELAY_PUSHED, RELAY_PUSHED]);
			h.env.advance(RELAY_TELL_MS);
			expect(socket.sent).toEqual([RELAY_PING, RELAY_PUSHED, RELAY_PUSHED]);
		});
	});

	it('closes its socket and listens to nothing once its session is over', async () => {
		const h = linked();
		const socket = await working(h);

		h.link.close();

		expect(socket.closes).toBe(1);
		expect(h.env.listening()).toBe(0);
		expect(h.env.pending()).toEqual([]);
		h.link.pushed();
		socket.events.heard(RELAY_CHANGED);
		expect(socket.sent).toEqual([RELAY_PING]);
		expect(h.onChanged).not.toHaveBeenCalled();
	});

	it('tries again when the browser will not open the socket at all', async () => {
		const h = linked({
			open: () => {
				throw new SyntaxError('bad URL');
			},
		});
		await settled();

		expect(h.env.pending()).toEqual([RELAY_RETRY_MS]);
	});
});

describe('the relay URL', () => {
	it('is the API on this page’s origin, over a secure socket where the page is secure', () => {
		expect(relayUrl('a.b', 'https://notes.example.com/notes/x?y=1')).toBe(
			'wss://notes.example.com/api/relay?ticket=a.b'
		);
		expect(relayUrl('a.b', 'http://localhost:5173/')).toBe(
			'ws://localhost:5173/api/relay?ticket=a.b'
		);
		expect(relayUrl('a/b+c', 'https://x.example/')).toBe(
			'wss://x.example/api/relay?ticket=a%2Fb%2Bc'
		);
	});
});

describe('relay links over the API', () => {
	const freshDatabase = (): NotesDatabase => {
		const db = createDatabase(`relay-${crypto.randomUUID()}`);
		cleanups.push(() => db.delete());
		return db;
	};

	const holding = async (connectionId: string) => {
		const db = freshDatabase();
		await db.credentials.put({
			id: connectionId,
			credential: `sk1_${connectionId}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		return db;
	};

	const CONFIG: InstanceConfig = { authMode: 'storage-first', providers: ['dropbox'] };

	const api = (
		config: () => Promise<InstanceConfig>,
		relayTicket: ApiClient['relayTicket'] = () =>
			Promise.resolve({ ok: true, value: { ticket: 'sealed', expiresIn: 30 } })
	) => {
		const ticketCalls = vi.fn<ApiClient['relayTicket']>(relayTicket);
		const withCredential = vi.fn(
			(credential: string) =>
				({ relayTicket: ticketCalls, credential }) as unknown as ApiClient
		);
		return { config: vi.fn(config), withCredential, relayTicket: ticketCalls };
	};

	const factoryFor = (db: NotesDatabase, client: ReturnType<typeof api>) => {
		const sockets = fakeSockets();
		const env = fakeEnvironment();
		const make = createRelayFactory({
			db,
			client,
			open: sockets.open,
			url: (ticket) => `wss://x/api/relay?ticket=${ticket}`,
			random: () => 1,
		});
		const linkFor = (connectionId: string) => {
			const link = make({ connectionId, environment: env.environment, onChanged: vi.fn() });
			cleanups.push(() => {
				link.close();
			});
			return link;
		};
		return { linkFor, sockets, env };
	};

	it('asks for a ticket with the credential held for the connection', async () => {
		const db = await holding('c1');
		const client = api(() => Promise.resolve({ ...CONFIG, relay: true }));
		const { linkFor, sockets } = factoryFor(db, client);

		linkFor('c1');
		await vi.waitFor(() => {
			expect(sockets.sockets).toHaveLength(1);
		});

		expect(client.withCredential).toHaveBeenCalledWith('sk1_c1');
		expect(sockets.last().url).toBe('wss://x/api/relay?ticket=sealed');
	});

	it('asks for no ticket at all on an instance without a relay, and asks that once', async () => {
		const db = await holding('c1');
		const client = api(() => Promise.resolve(CONFIG));
		const { linkFor, sockets, env } = factoryFor(db, client);

		linkFor('c1');
		await settled();
		linkFor('c1');
		await settled();

		expect(client.config).toHaveBeenCalledTimes(1);
		expect(client.relayTicket).not.toHaveBeenCalled();
		expect(sockets.sockets).toEqual([]);
		expect(env.pending()).toEqual([]);
	});

	it('asks whether there is a relay again when it could not find out', async () => {
		const db = await holding('c1');
		const client = api(
			vi
				.fn<() => Promise<InstanceConfig>>()
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockResolvedValue({ ...CONFIG, relay: true })
		);
		const { linkFor, sockets, env } = factoryFor(db, client);

		linkFor('c1');
		await settled();
		expect(env.pending()).toEqual([RELAY_RETRY_MS]);
		env.advance(RELAY_RETRY_MS);

		await vi.waitFor(() => {
			expect(sockets.sockets).toHaveLength(1);
		});
		expect(client.config).toHaveBeenCalledTimes(2);
	});

	it('stops where this device holds no credential for the connection', async () => {
		const db = freshDatabase();
		const client = api(() => Promise.resolve({ ...CONFIG, relay: true }));
		const { linkFor, sockets, env } = factoryFor(db, client);

		linkFor('c1');
		await quiet();

		expect(client.config).toHaveBeenCalled();
		expect(client.withCredential).not.toHaveBeenCalled();
		expect(sockets.sockets).toEqual([]);
		expect(env.pending()).toEqual([]);
	});

	const stopping: [string, ApiClient['relayTicket']][] = [
		[
			'refused the credential',
			() => Promise.resolve({ ok: false, refusal: 'credential_revoked' }),
		],
		['turned its relay off since', () => Promise.reject(new ApiError('gone', 404))],
	];

	it.each(stopping)('stops where the server %s', async (_case, relayTicket) => {
		const db = await holding('c1');
		const client = api(() => Promise.resolve({ ...CONFIG, relay: true }), relayTicket);
		const { linkFor, sockets, env } = factoryFor(db, client);

		linkFor('c1');
		await vi.waitFor(() => {
			expect(client.relayTicket).toHaveBeenCalled();
		});
		await quiet();

		expect(sockets.sockets).toEqual([]);
		expect(env.pending()).toEqual([]);
	});

	it('tries again where the server could not answer', async () => {
		const db = await holding('c1');
		const client = api(
			() => Promise.resolve({ ...CONFIG, relay: true }),
			() => Promise.reject(new ApiError('busy', 503))
		);
		const { linkFor, env } = factoryFor(db, client);

		linkFor('c1');
		await vi.waitFor(() => {
			expect(env.pending()).toEqual([RELAY_RETRY_MS]);
		});
	});
});
