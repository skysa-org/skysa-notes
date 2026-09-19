import { type SyncStateRecord } from './db.js';

/**
 * The sources this tab has let go of entirely, by connection id: whose account
 * each was, and what it was called.
 *
 * A source goes entirely when nothing it holds is unsent (`detachConnection`,
 * `releaseConnection` in `store/connection.ts`): its row is deleted with its
 * notes, and with it the only record of which account those notes were for. An
 * editor in this tab may still be holding text for one of them — typed while the
 * server was being asked, or a save that had been failing — and when that text
 * arrives the note is made again under its own source, which has to be made
 * again too (`ensureDetached` in `store/detached.ts`). Made from this, the row
 * says whose it is, so the panel can name it and connecting the same account
 * again takes the note home; made from nothing, it is "A source" that can only
 * be downloaded or discarded.
 *
 * In memory and per tab because the held edits are: they do not outlive the tab
 * either, and a tab that never had the source cannot be holding text for it.
 */
export type SourceIdentity = Pick<
	SyncStateRecord,
	'provider' | 'accountId' | 'displayName' | 'clientId'
>;

const gone = new Map<string, SourceIdentity>();

export const goneSources = {
	/** The source's row as it was, the moment it went. */
	remember: (state: SyncStateRecord): void => {
		const { provider, accountId, displayName, clientId } = state;
		gone.set(state.connectionId, {
			...(provider === undefined ? {} : { provider }),
			...(accountId === undefined ? {} : { accountId }),
			...(displayName === undefined ? {} : { displayName }),
			clientId,
		});
	},
	recall: (connectionId: string): SourceIdentity | undefined => gone.get(connectionId),
	/** Bound again under the same id: no longer gone, and its row says whose it is. */
	forget: (connectionId: string): void => {
		gone.delete(connectionId);
	},
};
