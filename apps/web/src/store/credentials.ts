import { type ProviderKind } from '@skysa/core';
import { type PromiseExtended } from 'dexie';

import { type CredentialRecord, type NotesDatabase, PENDING_CREDENTIAL_ID } from './db.js';

/**
 * The credential that proves this device's right to a connection.
 *
 * The device generates it, keeps it here, and sends the server only its
 * SHA-256 — so what the server holds mints nothing, and a dump of D1 is not a
 * set of keys (docs/ARCHITECTURE.md §6). The plaintext exists in exactly two places:
 * this table, and the `Authorization` header of a request in flight.
 *
 * IndexedDB and not `localStorage`, which the hard rules forbid for anything
 * like this, and not a cookie, which is the whole point: a bearer is never sent
 * ambiently, so CSRF stops being a class of bug here. The cost is that
 * IndexedDB has no `httpOnly`, which is why `script-src 'self'` is a hard
 * requirement rather than a good default — written out in CLAUDE.md and docs/ARCHITECTURE.md §6
 * rather than left for someone to infer.
 *
 * Nothing here is ever logged, put in a URL, or rendered. The device list in
 * `AccountPanel` shows the server's view of the grants, which carries no hashes.
 */

/** The `sk1_` version prefix, hashed along with the rest. See `apps/api/src/credentials.ts`. */
const CREDENTIAL_PREFIX = 'sk1_';

/** 32 bytes, the same as the server documents. */
const CREDENTIAL_BYTES = 32;

/**
 * How long a credential may sit unclaimed before it is treated as abandoned.
 *
 * A flow the user walked away from leaves one behind, and it is useless — the
 * server never saw its hash reach a callback. Long enough to survive a slow
 * consent screen on a phone, and a reload in the middle of one.
 */
const PENDING_TTL_MS = 60 * 60 * 1000;

const toBase64Url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

/** A fresh credential. Never reused: the server spends a hash on first use, for ever. */
export const newCredential = (): string =>
	`${CREDENTIAL_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES)))}`;

/** base64url SHA-256 of the whole credential string, prefix included. */
export const hashCredential = async (credential: string): Promise<string> =>
	toBase64Url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)))
	);

/**
 * Write down a credential for a flow about to start, and answer its hash.
 *
 * The caller **must** await this before navigating to the provider. A consent
 * the user has given with nothing written down here is a connection on the
 * server that this device cannot reach and cannot revoke, holding a live
 * refresh token — and the only way back is to disconnect it from another
 * device.
 *
 * One at a time, matching the server: the flow cookie holds one hash, so a
 * second flow started in another tab replaces the first. The tab that loses is
 * no worse off than a flow the user abandoned.
 */
export const beginConnect = async (
	db: Pick<NotesDatabase, 'credentials'>,
	provider: ProviderKind,
	now: number = Date.now()
): Promise<{ credential: string; credentialHash: string }> => {
	const credential = newCredential();
	await db.credentials.put({
		id: PENDING_CREDENTIAL_ID,
		credential,
		provider,
		createdAt: now,
	});
	return { credential, credentialHash: await hashCredential(credential) };
};

/** The credential a flow left behind, if one is still worth trying. */
export const pendingCredential = async (
	db: Pick<NotesDatabase, 'credentials'>,
	now: number = Date.now()
): Promise<CredentialRecord | undefined> => {
	const row = await db.credentials.get(PENDING_CREDENTIAL_ID);
	if (row === undefined) return undefined;
	if (now - row.createdAt > PENDING_TTL_MS) {
		await db.credentials.delete(PENDING_CREDENTIAL_ID);
		return undefined;
	}
	return row;
};

/**
 * Keep a credential the server has answered for, under the connection it
 * reaches.
 *
 * Deliberately not the other way round — the pending row is not promoted in
 * place, because until `GET /connection` answers there is nothing to key it by,
 * and a row keyed by a connection id this device guessed would be a credential
 * nothing could ever find again.
 */
export const keepCredential = async (
	db: Pick<NotesDatabase, 'credentials'>,
	connectionId: string,
	record: CredentialRecord
): Promise<void> => {
	await db.credentials.put({ ...record, id: connectionId });
	await db.credentials.delete(PENDING_CREDENTIAL_ID);
};

/** The credential for a connection, if this device holds one. */
export const credentialFor = (
	db: Pick<NotesDatabase, 'credentials'>,
	connectionId: string
): PromiseExtended<CredentialRecord | undefined> => db.credentials.get(connectionId);

/**
 * Every connection this device holds a credential for, newest first. The
 * pending one is not a connection and is left out.
 */
export const heldCredentials = async (
	db: Pick<NotesDatabase, 'credentials'>
): Promise<CredentialRecord[]> => {
	const rows = await db.credentials.toArray();
	return rows
		.filter((row) => row.id !== PENDING_CREDENTIAL_ID)
		.sort((a, b) => b.createdAt - a.createdAt);
};

/**
 * Throw a credential away. Called when the server says it no longer reaches
 * anything — a revoked device, a disconnected account — and after a disconnect
 * this device asked for.
 *
 * There is nothing to tell the server: it has already stopped honouring the
 * hash, and the hash stays spent there for ever so that a copy of this
 * credential taken before now can never be used to claim a connection of its
 * own (docs/ARCHITECTURE.md §6).
 */
export const forgetCredential = (
	db: Pick<NotesDatabase, 'credentials'>,
	connectionId: string
): PromiseExtended<void> => db.credentials.delete(connectionId);
