import { AuthError } from '@skysa/core';

import { type AccessToken, type ApiClient, type Refusal } from '../api/client.js';
import { type NotesDatabase } from '../store/db.js';

/**
 * Provider access tokens for one connection, minted by `apps/api` and held in
 * memory with a copy in the connection's `syncState` row, so a reload does not
 * need a round trip (docs/PLAN.md §8). Never localStorage (CLAUDE.md).
 *
 * The provider adapter asks `get` before every request. A token about to expire
 * is replaced before it is used rather than after the provider refuses it,
 * and `refresh` is what the engine calls when the provider refuses one anyway.
 */

/** A token this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;

export interface TokenSourceOptions {
	db: NotesDatabase;
	client: Pick<ApiClient, 'token'>;
	connectionId: string;
	now?: () => number;
}

export interface TokenSource {
	readonly get: () => Promise<string>;
	/** Mint a new token, whatever the one held says about itself. */
	readonly refresh: () => Promise<void>;
	/**
	 * Why the server last refused a token, until it next mints one. The
	 * engine cannot tell a refusal from any other failed request, so this is
	 * how the scheduler says "reconnect" rather than "retrying".
	 */
	readonly refusal: () => Refusal | undefined;
}

export const createTokenSource = (options: TokenSourceOptions): TokenSource => {
	const { db, client, connectionId } = options;
	const now = options.now ?? Date.now;
	const held = new Map<'token', AccessToken>();
	const refused = new Map<'refusal', Refusal>();

	const usable = (token: AccessToken | undefined): token is AccessToken =>
		token !== undefined && token.expiresAt - EXPIRY_MARGIN_MS > now();

	const mint = async (): Promise<string> => {
		const result = await client.token(connectionId);
		if (!result.ok) {
			refused.set('refusal', result.refusal);
			held.delete('token');
			// An `AuthError`, so the provider call it was for fails as one.
			throw new AuthError(`The server would not mint a token: ${result.refusal}`);
		}
		refused.delete('refusal');
		held.set('token', result.value);
		// `update`, not `put`: a connection unbound while the token was on its
		// way has no row, and must not get one back (`store/connection.ts`).
		await db.syncState.update(connectionId, {
			accessToken: result.value.accessToken,
			accessTokenExpiresAt: result.value.expiresAt,
		});
		return result.value.accessToken;
	};

	return {
		get: async () => {
			const inMemory = held.get('token');
			if (usable(inMemory)) return inMemory.accessToken;

			const state = await db.syncState.get(connectionId);
			const stored =
				state?.accessToken === undefined || state.accessTokenExpiresAt === undefined
					? undefined
					: { accessToken: state.accessToken, expiresAt: state.accessTokenExpiresAt };
			if (usable(stored)) {
				held.set('token', stored);
				return stored.accessToken;
			}
			return mint();
		},

		refresh: async () => {
			// Forgotten before the new one is asked for, row included: if it
			// cannot be had, the refused one must not be handed out again.
			held.delete('token');
			await db.syncState.update(connectionId, {
				accessToken: undefined,
				accessTokenExpiresAt: undefined,
			});
			await mint();
		},

		refusal: () => refused.get('refusal'),
	};
};
