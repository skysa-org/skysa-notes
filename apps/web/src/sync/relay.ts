import {
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from '@skysa/core';

import { type ApiClient, ApiError } from '../api/client.js';
import { credentialFor } from '../store/credentials.js';
import { type NotesDatabase } from '../store/db.js';

/**
 * The change relay, from this side (docs/ARCHITECTURE.md §6, "Change relay"):
 * a socket to `apps/api` for the session in front of the user, which says when
 * another device on the connection has pushed, and is how this one says it has.
 *
 * Only ever a hint. Polling goes on as it is: the relay never hears of an edit
 * made in the storage folder by anything else, and a socket that is down, or an
 * instance that runs none, must never be a reason a note does not arrive. So
 * nothing here reports a failure to anyone; it waits, and tries again.
 *
 * Open only while the app is in front of the user and online. A hidden tab
 * gives its socket up — the poll it goes back to on coming forward covers
 * whatever it missed — and a phone in a pocket holds nothing open.
 */

/** What the link needs of a socket, so a test can stand in for the browser's. */
export interface RelaySocket {
	readonly send: (text: string) => void;
	readonly close: () => void;
}

/** What a socket tells the link. Never called before `open` has returned. */
export interface RelaySocketEvents {
	readonly opened: () => void;
	readonly heard: (data: unknown) => void;
	readonly closed: (code: number) => void;
}

export type OpenRelaySocket = (url: string, events: RelaySocketEvents) => RelaySocket;

/** The scheduler's environment, as much of it as the link uses. */
export interface RelayEnvironment {
	readonly now: () => number;
	readonly isOnline: () => boolean;
	readonly isVisible: () => boolean;
	readonly listen: (
		event: 'visibilitychange' | 'online' | 'offline',
		handler: () => void
	) => () => void;
	/** Returns the way to cancel. */
	readonly setTimer: (callback: () => void, ms: number) => () => void;
}

/**
 * Whether to open a socket, and with what. `stop` is for this session: there
 * is nothing to connect to, or this device may no longer. A failure worth
 * trying again is thrown.
 */
export type TicketAnswer = { kind: 'ticket'; ticket: string } | { kind: 'stop' };

export interface RelayLinkOptions {
	readonly environment: RelayEnvironment;
	readonly ticket: () => Promise<TicketAnswer>;
	/** Where the socket is opened, given a ticket. */
	readonly url: (ticket: string) => string;
	readonly open: OpenRelaySocket;
	/** Another device on the connection has pushed. */
	readonly onChanged: () => void;
	/** For the backoff's jitter; `Math.random` unless a test says otherwise. */
	readonly random?: () => number;
}

export interface RelayLink {
	/** This device has just pushed: the connection's other devices are told. */
	readonly pushed: () => void;
	/** For good: the session it was for has ended. */
	readonly close: () => void;
}

/**
 * How often an open socket is asked whether it is still there. A connection
 * that died without a word — a phone moving between networks, a NAT that
 * forgot it — otherwise looks open for as long as the operating system lets it.
 */
export const RELAY_PING_MS = 45_000;
/** How long a ping has to be answered in before the socket counts as dead. */
export const RELAY_PONG_MS = 10_000;
/** The first retry after a failure; each one after doubles, up to the cap. */
export const RELAY_RETRY_MS = 1000;
export const RELAY_MAX_RETRY_MS = 60_000;
/**
 * The least time between two `pushed` this device sends. Half again the
 * relay's second, so the network's jitter cannot bring two inside it and have
 * the later one dropped — the one that says the last push happened.
 */
export const RELAY_TELL_MS = RELAY_PUSHED_INTERVAL_MS * 1.5;

type Timer = 'retry' | 'ping' | 'pong' | 'tell';

/**
 * `closed`: the session is over. `stopped`: told there is nothing to connect
 * to. `connecting`: a ticket is being asked for. `open`: the socket has opened.
 * `heard`: the server has said something on it. `owed`: a push it has not yet
 * been told of.
 */
type Flag = 'closed' | 'stopped' | 'connecting' | 'open' | 'heard' | 'owed';

/** What belongs to one socket, and goes with it. */
const SOCKET_TIMERS: readonly Timer[] = ['ping', 'pong', 'tell'];
const SOCKET_FLAGS: readonly Flag[] = ['connecting', 'open', 'heard'];

export const createRelayLink = (options: RelayLinkOptions): RelayLink => {
	const { environment, ticket, url, open, onChanged } = options;
	const random = options.random ?? Math.random;

	const flags = new Set<Flag>();
	const timers = new Map<Timer, () => void>();
	const socket = new Map<'socket', RelaySocket>();
	/** Failures in a row since the server last said anything, for the backoff. */
	const failures = new Map<'count', number>([['count', 0]]);
	/**
	 * Which attempt is current. A ticket that arrives, or a socket that speaks,
	 * after the link has let its attempt go is about nothing.
	 */
	const attempts = new Map<'count', number>([['count', 0]]);
	const lastTold = new Map<'at', number>();

	const cancel = (timer: Timer) => {
		timers.get(timer)?.();
		timers.delete(timer);
	};

	const arm = (timer: Timer, ms: number, callback: () => void) => {
		cancel(timer);
		timers.set(
			timer,
			environment.setTimer(() => {
				timers.delete(timer);
				callback();
			}, ms)
		);
	};

	const wanted = (): boolean =>
		!flags.has('closed') &&
		!flags.has('stopped') &&
		environment.isVisible() &&
		environment.isOnline();

	const send = (text: string) => {
		try {
			socket.get('socket')?.send(text);
		} catch {
			// Closing as it was sent to: its `close` is on its way.
		}
	};

	/** Let go of the socket, and of anything waiting on it or on a ticket. */
	const drop = () => {
		attempts.set('count', (attempts.get('count') ?? 0) + 1);
		SOCKET_TIMERS.forEach(cancel);
		SOCKET_FLAGS.forEach((flag) => {
			flags.delete(flag);
		});
		const held = socket.get('socket');
		socket.delete('socket');
		try {
			held?.close();
		} catch {
			// Gone already.
		}
	};

	const stop = () => {
		flags.add('stopped');
		drop();
		cancel('retry');
	};

	const failed = () => {
		const count = (failures.get('count') ?? 0) + 1;
		failures.set('count', count);
		const ceiling = Math.min(RELAY_RETRY_MS * 2 ** (count - 1), RELAY_MAX_RETRY_MS);
		// Half of it at least, and the rest by chance: a deploy closes every
		// socket at once, and they should not all come back in the same second.
		arm('retry', ceiling / 2 + (random() * ceiling) / 2, () => {
			void connect();
		});
	};

	/** Tell the relay of a push, as soon as there is a socket and the spacing allows. */
	const tell = () => {
		if (!flags.has('owed') || !flags.has('open')) return;
		const wait = (lastTold.get('at') ?? -Infinity) + RELAY_TELL_MS - environment.now();
		if (wait > 0) {
			arm('tell', wait, tell);
			return;
		}
		flags.delete('owed');
		lastTold.set('at', environment.now());
		send(RELAY_PUSHED);
	};

	const ping = () => {
		send(RELAY_PING);
		arm('pong', RELAY_PONG_MS, () => {
			drop();
			failed();
		});
		arm('ping', RELAY_PING_MS, ping);
	};

	const opened = () => {
		flags.add('open');
		// At once, not in 45 seconds: the answer is how the link knows the way
		// through to the relay works, and so that its backoff can start over.
		ping();
		tell();
	};

	const heard = (data: unknown) => {
		flags.add('heard');
		failures.set('count', 0);
		if (data === RELAY_PONG) {
			cancel('pong');
			return;
		}
		// Another device has pushed. Anything else is from a newer relay than
		// this app, and means nothing here.
		if (data === RELAY_CHANGED) onChanged();
	};

	const lost = (code: number) => {
		const working = flags.has('heard');
		drop();
		// Revoked or disconnected. The next request to the API is refused as
		// well, which is how the user hears of it (`sync/tokens.ts`).
		if (code === RELAY_CLOSE.revoked) {
			stop();
			return;
		}
		// Its hour is up: a new ticket at once, which asks the server again
		// whether this device may. Not for a socket that never worked, which
		// would otherwise be a loop as fast as the network.
		if (code === RELAY_CLOSE.expired && working) {
			void connect();
			return;
		}
		failed();
	};

	const connect = async (): Promise<void> => {
		if (!wanted() || socket.has('socket') || flags.has('connecting') || timers.has('retry')) {
			return;
		}
		flags.add('connecting');
		const attempt = attempts.get('count');
		const answer = await ticket().catch(() => undefined);
		// Let go of meanwhile — hidden, offline, closed — and perhaps already
		// asked for again.
		if (attempts.get('count') !== attempt) return;
		flags.delete('connecting');
		if (answer?.kind === 'stop') {
			stop();
			return;
		}
		if (answer === undefined) {
			failed();
			return;
		}

		const mine = (): boolean => attempts.get('count') === attempt;
		try {
			socket.set(
				'socket',
				open(url(answer.ticket), {
					opened: () => {
						if (mine()) opened();
					},
					heard: (data) => {
						if (mine()) heard(data);
					},
					closed: (code) => {
						if (mine()) lost(code);
					},
				})
			);
		} catch {
			// A URL the browser would not open: tried again, like any failure.
			failed();
		}
	};

	/** The tab came forward or went back, or the network came or went. */
	const moved = () => {
		if (wanted()) {
			void connect();
			return;
		}
		drop();
		cancel('retry');
	};

	const unlisten = [
		environment.listen('visibilitychange', moved),
		environment.listen('online', moved),
		environment.listen('offline', moved),
	];

	void connect();

	return {
		pushed: () => {
			if (flags.has('closed') || flags.has('stopped')) return;
			flags.add('owed');
			tell();
		},
		close: () => {
			flags.add('closed');
			drop();
			cancel('retry');
			unlisten.forEach((stopListening) => {
				stopListening();
			});
		},
	};
};

/** `/api/relay` on this page's origin, as the WebSocket URL the browser opens. */
export const relayUrl = (ticket: string, page: string = location.href): string => {
	const { protocol, host } = new URL(page);
	const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${host}/api/relay?ticket=${encodeURIComponent(ticket)}`;
};

/** The browser's `WebSocket`, as the link sees one. */
export const browserSocket: OpenRelaySocket = (url, events) => {
	const ws = new WebSocket(url);
	ws.addEventListener('open', () => {
		events.opened();
	});
	ws.addEventListener('message', (event) => {
		events.heard(event.data);
	});
	ws.addEventListener('close', (event) => {
		events.closed(event.code);
	});
	return {
		send: (text) => {
			ws.send(text);
		},
		// 1000, the one code a page closes with that says nothing went wrong.
		close: () => {
			ws.close(1000);
		},
	};
};

export interface RelayInput {
	readonly connectionId: string;
	readonly environment: RelayEnvironment;
	readonly onChanged: () => void;
}

/** A link for the session `follow` has just started (`sync/scheduler.ts`). */
export type RelayFactory = (input: RelayInput) => RelayLink;

export interface RelayFactoryOptions {
	readonly db: NotesDatabase;
	readonly client: Pick<ApiClient, 'config' | 'withCredential'>;
	readonly url?: (ticket: string) => string;
	readonly open?: OpenRelaySocket;
	readonly random?: () => number;
}

const STOP: TicketAnswer = { kind: 'stop' };

/**
 * Links over the app's API client. Whether the instance runs a relay at all is
 * asked of `/config` before anything else, and once it has answered it is not
 * asked again: on an instance without one, which is most, no session ever asks
 * for a ticket.
 */
export const createRelayFactory = (options: RelayFactoryOptions): RelayFactory => {
	const { db, client } = options;
	const enabled = new Map<'answer', Promise<boolean>>();

	const runsRelay = (): Promise<boolean> => {
		const asked =
			enabled.get('answer') ?? client.config().then((config) => config.relay === true);
		enabled.set('answer', asked);
		return asked.catch((error: unknown) => {
			// Not an answer: asked again next time.
			enabled.delete('answer');
			throw error;
		});
	};

	const ticketFor = (connectionId: string) => async (): Promise<TicketAnswer> => {
		if (!(await runsRelay())) return STOP;
		// Read fresh, as `sync/tokens.ts` reads it: a credential thrown away
		// since is not presented.
		const held = await credentialFor(db, connectionId);
		if (held === undefined) return STOP;
		const result = await client
			.withCredential(held.credential)
			.relayTicket()
			.catch((error: unknown) => {
				// The instance has turned its relay off since it said it ran one.
				if (error instanceof ApiError && error.status === 404) return undefined;
				throw error;
			});
		// A refusal is for the token source to tell the user about; the relay
		// only stops.
		return result?.ok === true ? { kind: 'ticket', ticket: result.value.ticket } : STOP;
	};

	return ({ connectionId, environment, onChanged }) =>
		createRelayLink({
			environment,
			onChanged,
			ticket: ticketFor(connectionId),
			url: options.url ?? relayUrl,
			open: options.open ?? browserSocket,
			...(options.random === undefined ? {} : { random: options.random }),
		});
};
