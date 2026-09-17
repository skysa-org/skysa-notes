import { type ProviderKind } from '@skysa/core';

import { type ApiClient, type Connection, type Refusal } from '../api/client.js';
import {
	accountKey,
	bindConnection,
	bindingCount,
	bindingMode,
	NOTES_ACCOUNT_KEY,
	rememberAccount,
	unbindConnection,
} from '../store/connection.js';
import { activeConnectionId, LOCAL_CONNECTION_ID, type NotesDatabase } from '../store/db.js';

/**
 * The storage account, as the server knows it, reconciled with the device.
 *
 * The server is the authority on *whether* an account is connected; the device
 * decides nothing but follows it. One connection until Phase 7 (docs/PLAN.md
 * §12.3), and only providers this build has an adapter for.
 */

/** Providers the app can sync with today. The rest arrive with their adapters. */
export const CONNECTABLE: readonly ProviderKind[] = ['dropbox'];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
	dropbox: 'Dropbox',
	onedrive: 'OneDrive',
	gdrive: 'Google Drive',
	webdav: 'WebDAV',
};

export type AccountState =
	/** Signed in, with the connection the device is now bound to. */
	| { kind: 'connected'; connection: Connection }
	/** Signed in, with nothing connected: the device keeps its notes to itself. */
	| { kind: 'none' }
	/**
	 * Signed in with an account other than the one the notes on this device
	 * belong to — most often the other of two Dropbox accounts the browser is
	 * logged in to, picked on the consent page. Binding it would copy every
	 * note into it, so nothing is bound until the user says (`adoptAccount`).
	 */
	| { kind: 'other-account'; connection: Connection }
	/**
	 * No session. The device keeps whatever connection it had — an expired
	 * session is not a disconnect, and reconnecting the same account keeps the
	 * connection's id, so its rows are already in place.
	 */
	| { kind: 'signed-out' };

/**
 * Ask the server which account is connected and bind the device to it.
 *
 * A connection the device is not bound to is bound: every note comes with it
 * (`store/connection.ts`). The server saying, with a session, that nothing is
 * connected unbinds the device — the connection was removed from another
 * device, and syncing a connection that no longer exists would fail forever.
 * Without a session nothing changes.
 *
 * Throws when the server cannot be asked at all: offline is not an answer.
 *
 * The answer is acted on only if the device is still bound where it was when
 * the question went out. If not — a disconnect, or another tab, got there first
 * — the server is asked again, once: what it said is about a device that no
 * longer exists.
 */
export const reconcileAccount = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'connections'>
): Promise<AccountState> => reconcileOnce(db, client, true);

const reconcileOnce = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'connections'>,
	again: boolean
): Promise<AccountState> => {
	const since = await bindingCount(db);
	const active = await activeConnectionId(db);
	const result = await client.connections();
	if (!result.ok) return { kind: 'signed-out' };

	const notesAccount = (await db.prefs.get(NOTES_ACCOUNT_KEY))?.value;
	const usable = result.value.filter((connection) => CONNECTABLE.includes(connection.provider));
	// The one already bound, if the server still has it: a second, newer row
	// would otherwise take over on every open. Then the notes' own account.
	const connection =
		usable.find((each) => each.id === active) ??
		usable.find((each) => accountKey(each.provider, each.accountId) === notesAccount) ??
		usable[0];

	// Nothing to change is a decision too, and as stale as any other.
	const unchanged = async () => (await bindingCount(db)) === since;
	const ask =
		connection !== undefined && connection.id !== active && (await needsAsking(db, connection));
	const applied =
		connection === undefined
			? active === LOCAL_CONNECTION_ID
				? await unchanged()
				: await unbindConnection(db, { ifUnchangedSince: since })
			: connection.id === active
				? await rememberAccount(db, {
						provider: connection.provider,
						accountId: connection.accountId,
						ifUnchangedSince: since,
					})
				: ask
					? await unchanged()
					: await bindConnection(db, {
							connectionId: connection.id,
							provider: connection.provider,
							accountId: connection.accountId,
							ifUnchangedSince: since,
						});
	if (!applied) {
		if (again) return reconcileOnce(db, client, false);
		throw new Error('The device changed connection while the server was being asked');
	}
	if (connection === undefined) return { kind: 'none' };
	return ask ? { kind: 'other-account', connection } : { kind: 'connected', connection };
};

/** Whether binding `connection` would copy notes that belong to another account into it. */
const needsAsking = async (db: NotesDatabase, connection: Connection): Promise<boolean> => {
	const { mode, from } = await bindingMode(db, connection);
	// An account the API does not name cannot be said to be another one: a
	// Worker older than this app, reconnecting the account the notes are from.
	const named = accountKey(connection.provider, connection.accountId) !== undefined;
	return mode === 'copy' && named && from !== undefined && (await holdsAnything(db));
};

/**
 * Whether the device holds anything of the account's: a note, a notebook, or a
 * delete still owed to one of its files — which a copy would drop, and the
 * note would come back the next time the account is connected.
 */
const holdsAnything = async (db: NotesDatabase): Promise<boolean> =>
	(await db.notes
		.filter((note) => note.deletedLocally === 0 || note.remoteId !== undefined)
		.count()) > 0 || (await db.folders.count()) > 0;

/**
 * Bind the device to `connection`, whichever account its notes belong to: the
 * user's answer to `other-account`, and what reconciling does when there is
 * nothing to ask.
 */
export const adoptAccount = async (
	db: NotesDatabase,
	connection: Connection
): Promise<AccountState> => {
	await bindConnection(db, {
		connectionId: connection.id,
		provider: connection.provider,
		accountId: connection.accountId,
	});
	return { kind: 'connected', connection };
};

export type DisconnectOutcome = { ok: true } | { ok: false; refusal: Refusal };

/**
 * Disconnect on the server, then here. Only in that order, and only once the
 * server has let go: unbinding first and failing to reach the server would
 * leave the account connected there — with a live refresh token — and the next
 * open would bind the device to it again.
 *
 * The notes stay on the device either way (`unbindConnection`). Nothing on the
 * remote is touched.
 */
export const disconnectAccount = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'disconnect'>,
	connectionId: string
): Promise<DisconnectOutcome> => {
	const result = await client.disconnect(connectionId);
	// Already gone on the server is what was asked for.
	if (!result.ok && result.refusal !== 'not_found') return result;
	await unbindConnection(db);
	return { ok: true };
};
