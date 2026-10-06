/**
 * The change relay's wire protocol, which the Worker and the app both speak
 * (docs/ARCHITECTURE.md §6, "Change relay"). Kept here so the two ends cannot
 * drift: a close code renamed at one end is a socket the other reconnects to
 * for ever, or gives up on for good.
 *
 * Neither message carries a path, an id or a version. A device told `changed`
 * runs an ordinary round against the provider, which is where the truth is.
 */

/** A device to the relay: this device has just pushed. */
export const RELAY_PUSHED = JSON.stringify({ t: 'pushed' });

/** The relay to every other device on the connection: something was pushed. */
export const RELAY_CHANGED = JSON.stringify({ t: 'changed' });

/** The keep-alive, and its answer, which the relay gives without waking. */
export const RELAY_PING = 'ping';
export const RELAY_PONG = 'pong';

/**
 * How the relay closes a socket on purpose, in the 4000–4999 range RFC 6455
 * §7.4.2 leaves to applications.
 */
export const RELAY_CLOSE = {
	/** The socket's hour is up: open another with a new ticket. */
	expired: 4001,
	/** The grant was revoked or the connection disconnected: do not. */
	revoked: 4003,
} as const;

/**
 * The relay passes on one `pushed` a second from each socket and drops the
 * rest. A device pushes at most once a round, and its rounds are seconds apart;
 * more than this is a device misbehaving, which the others should not pay for.
 */
export const RELAY_PUSHED_INTERVAL_MS = 1000;
