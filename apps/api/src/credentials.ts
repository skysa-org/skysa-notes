import { and, eq, gt, isNotNull } from 'drizzle-orm';

import { toBase64Url } from './crypto.js';
import { type Database, schema } from './db/client.js';

/**
 * The per-connection credential a device presents instead of a session.
 *
 * The device generates it, keeps it, and sends the server only its SHA-256.
 * Nothing here ever holds the plaintext: not the database, not a log, not a
 * `Location`, not a `Set-Cookie`, not a response body. A dump of D1 mints
 * nothing.
 *
 * What that buys and what it costs is written out in CLAUDE.md and
 * docs/ARCHITECTURE.md §6 — briefly: CSRF stops being a class of bug, a theft is
 * limited to one connection, and `httpOnly`'s protection against exfiltration
 * is given up in exchange, which is why `script-src 'self'` is a hard
 * requirement rather than a good idea.
 */

/**
 * Versioned, so a later proof-of-possession credential (a non-extractable
 * ECDSA key, which an XSS cannot copy out) can be told from this one by looking
 * at it. The seam is the prefix; nothing else needs to change to add `sk2_`.
 */
export const CREDENTIAL_PREFIX = 'sk1_';

/** 32 bytes of `crypto.getRandomValues`, base64url, unpadded. */
export const CREDENTIAL_BYTES = 32;

/** A SHA-256 digest as base64url: 32 bytes, unpadded, always 43 characters. */
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * How long a grant survives without being used. Long enough that a device used
 * occasionally is not logged out, short enough that a credential stolen from a
 * machine nobody touches again stops working. Checked on read — there is no
 * sweep, and a Worker has nowhere to run one.
 */
export const GRANT_IDLE_DAYS = 180;

/**
 * How much of a day has to pass before a request writes `lastUsedAt`. Touching
 * it on every request would be a D1 write per request; once a day is
 * indistinguishable to idle expiry and to the device list.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = DAY_MS;

/** How many devices may hold one connection at once. Oldest lose their place. */
export const MAX_GRANTS_PER_CONNECTION = 20;

export const isCredentialHash = (value: unknown): value is string =>
	typeof value === 'string' && HASH_PATTERN.test(value);

/**
 * The lookup key for a credential.
 *
 * Over the whole credential string, prefix included, so `sk1_x` and a future
 * `sk2_x` hash differently and a credential cannot be replayed as another
 * version of itself.
 */
export const hashCredential = async (credential: string): Promise<string> =>
	toBase64Url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)))
	);

/**
 * The credential out of an `Authorization` header, if there is a well-formed
 * one. The scheme is case-insensitive per RFC 9110 §11.4; the prefix is not.
 */
export const bearerFrom = (header: string | undefined | null): string | undefined => {
	if (header === undefined || header === null) return undefined;
	const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(header.trim());
	const token = match?.[1];
	if (token === undefined || !token.startsWith(CREDENTIAL_PREFIX)) return undefined;
	return token;
};

export interface Bearer {
	/** Its `connectionId` is known non-null: `grantHolder` only returns live ones. */
	grant: typeof schema.grants.$inferSelect;
	connection: typeof schema.connections.$inferSelect;
}

/**
 * Who is calling, from the `Authorization` header.
 *
 * One indexed read on the hash, so there is no id-to-compare step and so no
 * hand-rolled constant-time comparison — `crypto.subtle.timingSafeEqual` is a
 * Workers extension that Node's webcrypto does not have, and the suite runs on
 * Node.
 *
 * `undefined` covers every way of not being authorized, and the caller is
 * expected to tell the two apart by whether a header was sent at all: a device
 * with no credential has to connect, a device whose credential is unknown has
 * to throw it away first.
 */
export const grantHolder = async (
	db: Database,
	credential: string,
	now = Date.now()
): Promise<Bearer | undefined> => {
	const hash = await hashCredential(credential);

	// Revocation and idle expiry are both part of the lookup rather than checks
	// afterwards, so a revoked or expired grant is indistinguishable from an
	// unknown one — including in how long the answer takes.
	//
	// A row existing says nothing about whether it may still be used. Revoked,
	// disconnected and pruned grants keep their rows, with `connection_id` set to
	// null, so that their hashes can never be claimed a second time (see
	// apps/api/src/db/schema.ts). `IS NOT NULL` is what tells those apart from
	// live ones. No mutation of it can be made to fail a test, because there are
	// three guards and not one: this clause, the null branch below, and the fact
	// that a null would not match a connection id in the second query either.
	// Keeping all three is deliberate — the middle one is the cheapest to delete
	// by accident, and the only one that would be load-bearing if this were ever
	// rewritten to a query that coerces rather than one that returns nothing.
	const grant = await db.query.grants.findFirst({
		where: and(
			eq(schema.grants.secretHash, hash),
			isNotNull(schema.grants.connectionId),
			gt(schema.grants.lastUsedAt, new Date(now - GRANT_IDLE_DAYS * DAY_MS))
		),
	});
	if (grant?.connectionId === undefined || grant.connectionId === null) return undefined;

	const connection = await db.query.connections.findFirst({
		where: eq(schema.connections.id, grant.connectionId),
	});
	// The foreign key makes this unreachable; treating it as "not authorized"
	// rather than throwing keeps a torn write from being a 500.
	if (connection === undefined) return undefined;

	await touch(db, grant, now);
	return { grant, connection };
};

/**
 * The one read path that writes. Rate-limited to once a day, and its failure is
 * swallowed: a grant whose timestamp could not be refreshed is still valid
 * today.
 */
const touch = async (
	db: Database,
	grant: typeof schema.grants.$inferSelect,
	now: number
): Promise<void> => {
	// `lastUsedAt` is `NOT NULL` and set to `createdAt` on insert, so there is no
	// null case to consider — a nullable one would also fail the `>` the idle
	// check in `grantHolder` is written as.
	if (now - grant.lastUsedAt.getTime() < TOUCH_AFTER_MS) return;
	await db
		.update(schema.grants)
		.set({ lastUsedAt: new Date(now) })
		.where(eq(schema.grants.id, grant.id))
		.catch(() => undefined);
};
