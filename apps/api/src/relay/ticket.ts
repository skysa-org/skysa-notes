import { z } from 'zod';

import { open, seal, type SecretKey } from '../crypto.js';

/**
 * What lets a device open a relay socket without its credential in the URL.
 *
 * A browser cannot set `Authorization` on a WebSocket, and `sk1_` must never be
 * in a URL, which logs keep. So the device asks for a ticket with its bearer,
 * as for anything else on its connection, and opens the socket with that.
 *
 * Sealed rather than signed: AES-GCM authenticates it, and keeps the grant and
 * connection ids it names out of whatever logs the URL lands in. Derived from
 * nothing the device holds. Not single-use — that would take a table and a
 * write per connect, and a ticket replayed inside its lifetime buys a socket
 * that hears "changed" for a grant the upgrade checks is still live
 * (docs/ARCHITECTURE.md §6, "Change relay").
 */

/** Long enough for the request after this one, and no longer. */
export const TICKET_SECONDS = 30;

/** Far longer than any ticket this makes; anything past it is not one. */
const MAX_TICKET_LENGTH = 512;

const payloadSchema = z.object({
	g: z.string().min(1),
	c: z.string().min(1),
	e: z.number().int(),
});

export interface TicketHolder {
	readonly grantId: string;
	readonly connectionId: string;
}

/** `seal` speaks base64; a query string wants it URL-safe. */
const urlSafe = (base64: string): string =>
	base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const issueTicket = async (
	key: SecretKey,
	holder: TicketHolder,
	now: number
): Promise<string> => {
	const sealed = await seal(
		key,
		JSON.stringify({
			g: holder.grantId,
			c: holder.connectionId,
			e: now + TICKET_SECONDS * 1000,
		})
	);
	return `${urlSafe(sealed.iv)}.${urlSafe(sealed.ciphertext)}`;
};

/**
 * Who a ticket was issued to, or `undefined` for anything that is not a live
 * ticket of this deployment's: malformed, tampered with, sealed under another
 * key, or past its time. Never throws — what arrives here is whatever was put
 * in a query string.
 */
export const readTicket = async (
	key: SecretKey,
	ticket: string | undefined,
	now: number
): Promise<TicketHolder | undefined> => {
	if (ticket === undefined || ticket.length > MAX_TICKET_LENGTH) return undefined;
	const parts = ticket.split('.');
	const [iv, ciphertext] = parts;
	if (parts.length !== 2 || iv === undefined || ciphertext === undefined) return undefined;
	if (iv === '' || ciphertext === '') return undefined;

	const plaintext = await open(key, { iv, ciphertext, keyId: key.id }).catch(() => undefined);
	if (plaintext === undefined) return undefined;

	const parsed = payloadSchema.safeParse(
		((): unknown => {
			try {
				return JSON.parse(plaintext);
			} catch {
				return undefined;
			}
		})()
	);
	if (!parsed.success || parsed.data.e <= now) return undefined;

	return { grantId: parsed.data.g, connectionId: parsed.data.c };
};
