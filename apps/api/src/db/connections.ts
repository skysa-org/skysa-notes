import { and, desc, eq, notExists, notInArray } from 'drizzle-orm';

import { MAX_GRANTS_PER_CONNECTION, notIdle } from '../credentials.js';
import { randomBase64Url, type SealedSecret, secretColumns } from '../crypto.js';
import { logFailure } from '../log.js';
import type { OAuthProviderKind } from '../oauth/providers.js';
import { type Database, schema } from './client.js';

/**
 * The writes to `connections` and `grants` that have a race to get right, kept
 * here with the reasoning about it (#450). A route says when one happens and
 * why; this says how it stays right with another request in between. Writes
 * with nothing to race stay where they are: a credential's use (`touch`, in
 * `credentials.ts`) and Disconnect's delete of the whole row.
 */

interface CommitInput {
	provider: OAuthProviderKind;
	accountId: string;
	displayName: string;
	sealed: SealedSecret;
	credentialHash: string;
	/** What the device is, as a label (`deviceLabel`); not every browser says. */
	device: string | undefined;
	now: number;
}

/**
 * The connection and the grant, or neither.
 *
 * One `db.batch`, which D1 runs as a single transaction: a connection stored
 * without the grant that reaches it would be an account connected and
 * unreachable, holding a live refresh token nothing can revoke.
 *
 * Two callbacks racing for the same *new* account each compute their own row
 * id. The unique index on `(provider, account_id)` turns the loser's insert
 * into an update of the winner's row, leaving its grant pointing at an id that
 * does not exist — a foreign key violation, which rolls the whole batch back
 * rather than leaving half of it. The retry then finds the winner's row and
 * attaches to it.
 *
 * Everything that is not `ok` is retried once, `claimed` included. An earlier
 * draft retried only the throw, on the reasoning that a spent hash is spent
 * however often you ask — true of the hash, false of the comparison: the
 * connection id it is compared against comes from a read, and a read that is
 * stale invents a fresh id, so a device reconnecting with its own live
 * credential is told `claimed` and its new refresh token is thrown away. One
 * more indexed read is a small price for not answering a transient read with a
 * permanent-looking refusal. Bounded at one all the same: a second disagreement
 * is not a race.
 */
export const commitConnection = async (
	db: Database,
	input: CommitInput
): Promise<Stored | undefined> => {
	const first = await attempt(db, input, 'storing the connection failed');
	if (typeof first === 'object') return first;

	const second = await attempt(db, input, 'storing the connection failed on retry');
	return typeof second === 'object' ? second : undefined;
};

/** What a commit did: the row the grant is on, and the grants the cap evicted. */
interface Stored {
	readonly connectionId: string;
	readonly pruned: readonly string[];
}

/**
 * A `Stored` stored it. `claimed` means the hash is bound somewhere else —
 * spent, or read against a connection id this attempt could not see. `failed`
 * is a throw.
 */
type Attempt = Stored | 'claimed' | 'failed';

const attempt = async (db: Database, input: CommitInput, whenItFails: string): Promise<Attempt> =>
	store(db, input).catch((error: unknown) => {
		logFailure(whenItFails, error);
		return 'failed' as const;
	});

const store = async (db: Database, input: CommitInput): Promise<Attempt> => {
	const { provider, accountId, displayName, sealed, credentialHash, device, now } = input;

	const existing = await db.query.connections.findFirst({
		where: and(
			eq(schema.connections.provider, provider),
			eq(schema.connections.accountId, accountId)
		),
	});

	// One id, decided once: the insert and the conflict update must agree, or the
	// grant would be attached to a row under an id neither returned.
	const connectionId = existing?.id ?? randomBase64Url(16);

	// A hash is claimable exactly once, ever. `grants` rows are never deleted —
	// revoking, disconnecting and pruning all null `connection_id` and leave the
	// row behind — so a hash that has been used is either still this device's or
	// permanently spent.
	//
	// Both halves of that matter. Letting a spent hash be re-claimed is the hole
	// an earlier draft had: an attacker holding a hash from a database dump waits
	// for the grant to go (a disconnect-and-reconnect, a revoke, a prune), starts
	// a flow with it, consents with storage of their own, and the victim's
	// offline device comes back to a 200 and syncs its notes into a stranger's
	// Drive, with nothing anywhere to tell it otherwise. Refusing *every* repeat
	// was the opposite bug: a device that reconnects with the credential it
	// already holds — which no rule forbids — failed the batch, so it never got a
	// working connection and no retry could ever give it one.
	const held = await db.query.grants.findFirst({
		where: eq(schema.grants.secretHash, credentialHash),
	});
	if (held !== undefined && held.connectionId !== connectionId) return 'claimed';

	const secret = secretColumns(sealed);

	const [, , pruned] = await db.batch([
		db
			.insert(schema.connections)
			.values({
				id: connectionId,
				provider,
				accountId,
				displayName,
				...secret,
				createdAt: new Date(now),
				lastUsedAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [schema.connections.provider, schema.connections.accountId],
				// Not `id`, and not `rootId`: the row is the account, so the folder it
				// discovered is still that account's folder, and devices already
				// holding grants still have to find it under the same id.
				set: { displayName, ...secret, lastUsedAt: new Date(now) },
			}),

		// A plain insert for a hash nobody holds, deliberately — never an upsert on
		// `secret_hash`, which would hand the row to whoever presented the hash
		// last. Between the read above and this line another flow can claim it, and
		// then the unique index rolls the whole batch back; the retry re-reads and
		// answers `claimed` instead of looping.
		held === undefined
			? db.insert(schema.grants).values({
					id: randomBase64Url(16),
					connectionId,
					secretHash: credentialHash,
					createdAt: new Date(now),
					lastUsedAt: new Date(now),
					device: device ?? null,
				})
			: // This device reconnecting with the credential it already holds. Its
				// row is already pointed at this connection; all that changes is that
				// it counts as recently used, so the prune below keeps it.
				db
					.update(schema.grants)
					// And it may be another browser on it than signed in before.
					.set({ lastUsedAt: new Date(now), ...(device === undefined ? {} : { device }) })
					.where(eq(schema.grants.id, held.id)),

		// A cap, so a connection cannot accumulate grants without limit — every
		// one of them a live key to the same storage. The least recently used lose
		// their place: that is the device least likely to still exist, and it means
		// a grant already past its idle expiry is evicted before a live one rather
		// than sitting in the cap holding a slot it can no longer use.
		//
		// An update, not a delete — the row stays as the tombstone that keeps its
		// hash spent. In the same batch as the insert, so the subquery sees the new
		// row and the connection is never briefly over its cap. `id` breaks a tie
		// on `lastUsedAt`, because two devices can connect inside one millisecond
		// and a prune that is not a total order would drop an arbitrary one.
		db
			.update(schema.grants)
			.set({ connectionId: null })
			.where(
				and(
					eq(schema.grants.connectionId, connectionId),
					notInArray(
						schema.grants.id,
						db
							.select({ id: schema.grants.id })
							.from(schema.grants)
							.where(eq(schema.grants.connectionId, connectionId))
							.orderBy(desc(schema.grants.lastUsedAt), desc(schema.grants.id))
							.limit(MAX_GRANTS_PER_CONNECTION)
					)
				)
			)
			// Which ones, so the callback can close their relay sockets.
			.returning({ id: schema.grants.id }),
	]);

	return { connectionId, pruned: pruned.map((row) => row.id) };
};

/**
 * Take one device's grant off its connection.
 *
 * Nulled, not deleted. Deleting would free the hash, and a freed hash is
 * re-claimable: whoever holds the credential this row was for — which is
 * exactly the thief the user is revoking — could start a fresh flow with
 * it, consent with storage of their own, and be handed a working grant.
 * The row stays so the hash stays spent (see apps/api/src/db/schema.ts).
 */
export const revokeGrant = async (db: Database, grantId: string): Promise<void> => {
	await db.update(schema.grants).set({ connectionId: null }).where(eq(schema.grants.id, grantId));
};

/**
 * Delete the connection if no live grant reaches it any more. Answers whether
 * it did.
 *
 * One statement, asking and deleting together. Asked first and deleted
 * afterwards, another device's callback can commit its grant to this row in
 * the gap — which a caller that talks to the provider in between, as
 * revoking a device does, makes up to twenty seconds long — and then watch
 * the row deleted from under it: told `ok`, holding a credential that
 * reaches nothing, its hash spent. The callback's batch
 * is atomic too, so it lands wholly before this, and the row stays, or
 * wholly after, and it makes a fresh one.
 */
export const deleteIfOrphaned = async (db: Database, connectionId: string): Promise<boolean> => {
	const gone = await db
		.delete(schema.connections)
		.where(
			and(
				eq(schema.connections.id, connectionId),
				notExists(
					db
						.select({ id: schema.grants.id })
						.from(schema.grants)
						.where(
							and(eq(schema.grants.connectionId, connectionId), notIdle(Date.now()))
						)
				)
			)
		)
		.returning({ id: schema.connections.id });
	return gone.length > 0;
};

/**
 * A refresh went through: the connection was used just now, and holds the
 * refresh token the provider rotated to, where it rotated one.
 */
export const recordRefresh = async (
	db: Database,
	connectionId: string,
	rotated: SealedSecret | undefined
): Promise<void> => {
	await db
		.update(schema.connections)
		.set({
			lastUsedAt: new Date(),
			...(rotated === undefined ? {} : secretColumns(rotated)),
		})
		.where(eq(schema.connections.id, connectionId));
};
