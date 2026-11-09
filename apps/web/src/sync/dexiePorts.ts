import type { NotesDatabase } from '../store/db.js';
import { updateLive } from '../store/detached.js';
import type { TokenStates } from './tokens.js';

/**
 * The sync client's ports, over this app's database. The client goes to the
 * shared kit and reaches IndexedDB only through ports
 * (docs/decisions/0018-the-shared-kit.md); the tables they are made over, and
 * these, stay with the app. The credentials need none: the database fits
 * `CredentialStore` as it is.
 */

/**
 * A connection's token, kept on its `syncState` row so a reload need not ask
 * the server again. Written only onto a live row (`updateLive`): a connection
 * let go while its token was on the way has no row and must not get one back,
 * or has a detached one, which must not hold a key to the account
 * (`store/detached.ts`).
 */
export const tokenStatesOf = (db: NotesDatabase): TokenStates => ({
	read: async (connectionId) => {
		const state = await db.syncState.get(connectionId);
		const token =
			state?.accessToken === undefined || state.accessTokenExpiresAt === undefined
				? undefined
				: { accessToken: state.accessToken, expiresAt: state.accessTokenExpiresAt };
		return { detached: state?.detached !== undefined, token };
	},
	keep: (connectionId, token) =>
		updateLive(
			db,
			connectionId,
			({ accessToken: _token, accessTokenExpiresAt: _expiry, ...rest }) =>
				token === undefined
					? rest
					: {
							...rest,
							accessToken: token.accessToken,
							accessTokenExpiresAt: token.expiresAt,
						}
		),
});
