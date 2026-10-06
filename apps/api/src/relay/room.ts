import { z } from 'zod';

import { RELAY_CLOSE } from './hub.js';

/**
 * What one connection's relay does with a frame, apart from the runtime that
 * carries it (docs/ARCHITECTURE.md §6, "Change relay"). The Durable Object maps
 * its hibernatable sockets onto `RoomSocket`; this decides who hears what.
 *
 * Two messages and nothing else. A device sends `pushed` after a round that
 * pushed something, and every other device on the connection is sent
 * `changed`. Neither carries a path, an id or a version: the device that hears
 * one runs an ordinary round against the provider, which is where the truth is.
 */

/** Per socket, kept with it across hibernation. */
export interface Seat {
	readonly grantId: string;
	/** Epoch ms after which the socket is closed rather than used. */
	readonly until: number;
	/** When this socket's last `pushed` was passed on; 0 for never. */
	readonly lastPushedAt: number;
}

export interface RoomSocket {
	readonly seat: Seat;
	readonly reseat: (seat: Seat) => void;
	readonly send: (text: string) => void;
	readonly close: (code: number, reason: string) => void;
}

/** What every other device is sent. */
export const CHANGED = JSON.stringify({ t: 'changed' });

/**
 * One `pushed` a second per socket is passed on, and the rest are dropped. A
 * device pushes at most once a round, and its rounds are seconds apart; more
 * than this is a device misbehaving, which the others should not pay for.
 */
export const PUSHED_INTERVAL_MS = 1000;

/** Far larger than either message, and small enough to refuse before parsing. */
export const MAX_FRAME_BYTES = 256;

/** RFC 6455 §7.4.1: "a message that violates its policy". */
const POLICY_VIOLATION = 1008;

const frameSchema = z.object({ t: z.literal('pushed') }).strict();

const isPushed = (message: string | ArrayBuffer): boolean => {
	if (typeof message !== 'string') return false;
	if (new TextEncoder().encode(message).length > MAX_FRAME_BYTES) return false;
	try {
		return frameSchema.safeParse(JSON.parse(message)).success;
	} catch {
		return false;
	}
};

const expired = (socket: RoomSocket, now: number): boolean => socket.seat.until <= now;

/**
 * A frame arrived on `from`. `everyone` is every socket on the connection,
 * `from` included.
 *
 * A socket past its hour is closed instead of heard or told, so a device whose
 * grant has gone stops hearing within the hour whether or not the hub was told.
 * Closing it is how it learns to come back with a new ticket.
 */
export const onFrame = (
	from: RoomSocket,
	message: string | ArrayBuffer,
	everyone: readonly RoomSocket[],
	now: number
): void => {
	if (expired(from, now)) {
		from.close(RELAY_CLOSE.expired, 'expired');
		return;
	}
	if (!isPushed(message)) {
		from.close(POLICY_VIOLATION, 'unexpected message');
		return;
	}
	if (now - from.seat.lastPushedAt < PUSHED_INTERVAL_MS) return;
	from.reseat({ ...from.seat, lastPushedAt: now });

	everyone
		// Not the device that pushed, in any of its tabs: they share its store.
		.filter((socket) => socket.seat.grantId !== from.seat.grantId)
		.forEach((socket) => {
			if (expired(socket, now)) socket.close(RELAY_CLOSE.expired, 'expired');
			else socket.send(CHANGED);
		});
};

/** The grants have gone: close their sockets, or every socket when none are named. */
export const onRevoke = (everyone: readonly RoomSocket[], grantIds?: readonly string[]): void => {
	everyone
		.filter((socket) => grantIds === undefined || grantIds.includes(socket.seat.grantId))
		.forEach((socket) => {
			socket.close(RELAY_CLOSE.revoked, 'revoked');
		});
};
