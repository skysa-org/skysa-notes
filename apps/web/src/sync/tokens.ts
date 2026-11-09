import { AuthError, cell } from '@skysa/core';

import type { AccessToken, ApiClient, Denial, Refusal } from '../api/client.js';
import { credentialFor, type CredentialStore } from '../store/credentials.js';

/**
 * Provider access tokens for one connection, minted by `apps/api` and held in
 * memory with a copy in the connection's `syncState` row, so a reload does not
 * need a round trip (docs/ARCHITECTURE.md §8). Never localStorage (CLAUDE.md).
 *
 * The provider adapter asks `get` before every request. A token about to expire
 * is replaced before it is used rather than after the provider refuses it,
 * and `refresh` is what the engine calls when the provider refuses one anyway.
 *
 * It goes to the shared kit (docs/decisions/0018-the-shared-kit.md), so the
 * row is reached through a port (`TokenStates`), which the app makes over its
 * database (`sync/dexiePorts.ts`).
 */

/** A token this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Where a connection's token is kept between loads, and whether it is still
 * synced. IndexedDB or memory, never `localStorage` (CLAUDE.md).
 */
export interface TokenStates {
	/**
	 * Whether the device has let the connection go (`detached`), keeping it
	 * for what it never sent, and the token kept for it, if any.
	 */
	readonly read: (
		connectionId: string
	) => Promise<Readonly<{ detached: boolean; token?: AccessToken | undefined }>>;
	/**
	 * Keep `token` for the connection, or forget the one kept. Onto a synced
	 * connection only: one let go while a token was on its way must not get a
	 * key to the account back.
	 */
	readonly keep: (connectionId: string, token: AccessToken | undefined) => Promise<void>;
}

export interface TokenSourceOptions {
	/** Where the device's credentials are held. */
	credentials: CredentialStore;
	states: TokenStates;
	client: Pick<ApiClient, 'withCredential'>;
	connectionId: string;
	now?: () => number;
}

export interface TokenSource {
	readonly get: () => Promise<string>;
	/** Mint a new token, whatever the one held says about itself. */
	readonly refresh: () => Promise<void>;
	/**
	 * Why the server last refused a token, until a token is had again from
	 * anywhere, or the server fails to answer at all. The
	 * engine cannot tell a refusal from any other failed request, so this is
	 * how the scheduler says "reconnect" rather than "retrying".
	 */
	readonly refusal: () => Refusal | undefined;
	/** What the operator's policy said beside that refusal, when it was `not_entitled`. */
	readonly denial: () => Denial | undefined;
}

export const createTokenSource = (options: TokenSourceOptions): TokenSource => {
	const { credentials, states, client, connectionId } = options;
	const now = options.now ?? Date.now;
	const cached = cell<AccessToken | undefined>(undefined);
	const refused = cell<{ refusal: Refusal; denial?: Denial | undefined } | undefined>(undefined);

	const usable = (token: AccessToken | undefined): token is AccessToken =>
		token !== undefined && token.expiresAt - EXPIRY_MARGIN_MS > now();

	/** A token in hand, from wherever: whatever the server said before is no longer so. */
	const using = (token: AccessToken): string => {
		refused.current = undefined;
		cached.current = token;
		return token.accessToken;
	};

	const mint = async (): Promise<string> => {
		// Read fresh on every mint rather than held: a device revoked from
		// somewhere else, or a source the user disconnected in another tab, must
		// stop minting rather than go on presenting a credential that is gone.
		const held = await credentialFor(credentials, connectionId);
		if (held === undefined) {
			refused.current = { refusal: 'credential_required' };
			cached.current = undefined;
			throw new AuthError('This device holds no credential for that connection');
		}

		const result = await client
			.withCredential(held.credential)
			.token()
			.catch((error: unknown) => {
				// Not an answer: the server may since have changed its mind, and a
				// refusal kept past this would read as one it gave just now.
				refused.current = undefined;
				throw error;
			});
		if (!result.ok) {
			refused.current = { refusal: result.refusal, denial: result.denial };
			cached.current = undefined;
			// An `AuthError`, so the provider call it was for fails as one.
			throw new AuthError(`The server would not mint a token: ${result.refusal}`);
		}
		using(result.value);
		await states.keep(connectionId, result.value);
		return result.value.accessToken;
	};

	/**
	 * The mint under way, which every request that finds the token spent while
	 * it is out waits on. Notes are written several at once on Google Drive
	 * (`StorageProvider.writesAtOnce`), and each of them finding the token
	 * expired asked the server for one of its own.
	 */
	const minting = cell<Promise<string> | undefined>(undefined);
	const mintOnce = (): Promise<string> => {
		const under = minting.current;
		if (under !== undefined) return under;
		const minted = mint().finally(() => {
			minting.current = undefined;
		});
		minting.current = minted;
		return minted;
	};

	return {
		get: async () => {
			const inMemory = cached.current;
			if (usable(inMemory)) return using(inMemory);

			const state = await states.read(connectionId);
			// A detached source is never minted for. Nothing starts a session for
			// one, so this is for a run that was already going when it was let go:
			// it stops here rather than at the server.
			if (state.detached) {
				refused.current = { refusal: 'credential_required' };
				cached.current = undefined;
				throw new AuthError('This device no longer syncs that connection');
			}
			// Minted by another tab, perhaps after this one was refused.
			if (usable(state.token)) return using(state.token);
			return mintOnce();
		},

		refresh: async () => {
			// Forgotten before the new one is asked for, row included: if it
			// cannot be had, the refused one must not be handed out again.
			cached.current = undefined;
			await states.keep(connectionId, undefined);
			await mint();
		},

		refusal: () => refused.current?.refusal,
		denial: () => refused.current?.denial,
	};
};
