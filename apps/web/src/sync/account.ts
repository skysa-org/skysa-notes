import { type ProviderKind } from '@skysa/core';

import { type ApiClient, type Connection, type Refusal } from '../api/client.js';
import {
	accountKey,
	bindConnection,
	bindingCount,
	bindingMode,
	rememberAccount,
	unbindConnection,
} from '../store/connection.js';
import {
	credentialFor,
	forgetCredential,
	keepCredential,
	pendingCredential,
} from '../store/credentials.js';
import {
	activeConnectionId,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	PENDING_CREDENTIAL_ID,
} from '../store/db.js';

/**
 * The storage account, as the server knows it, reconciled with the device.
 *
 * The server is the authority on *whether* the connection this device's
 * credential reaches still exists; the device decides nothing but follows it.
 * Only providers this build has an adapter for.
 *
 * The question is now asked with a credential rather than a session, and that
 * changes what an answer means. There is no "signed out" — a credential either
 * reaches a connection or has stopped reaching anything, for ever. So the
 * device unbinds on a definite answer *about its own connection*
 * (`credential_revoked`: revoked from another device, or the account
 * disconnected) and on nothing else. Offline, a 5xx or a body it cannot read
 * throws, and the device keeps what it has — which is the fix for the reconcile
 * race arriving from the other side, since there is no longer a list that can
 * fail to mention a connection (docs/PLAN.md §6).
 */

/** Providers the app can sync with today. The rest arrive with their adapters. */
export const CONNECTABLE: readonly ProviderKind[] = ['dropbox', 'onedrive', 'gdrive'];

/** A page at the provider where the user withdraws the app's access. */
export interface RevokePlace {
	readonly label: string;
	readonly href: string;
	/** Whose accounts it is for, as the end of "… for {accounts}". */
	readonly accounts: string;
}

/**
 * What disconnecting leaves behind at the provider, where it leaves anything.
 * Dropbox lets the server withdraw the app's access; Microsoft gives an app no
 * way to withdraw its own, so the user has to (docs/PLAN.md §5.2). A grant an
 * administrator consented to cannot be removed by the user at all.
 * https://support.microsoft.com/en-us/account-billing/edit-or-revoke-application-permissions-in-the-my-apps-portal-169be2b4-ee26-4338-aea8-d19bb2f329ee
 * https://learn.microsoft.com/en-us/answers/questions/4375979/article-managing-apps-and-services-connected-to-ou
 */
export const LEFT_AT_PROVIDER: Partial<
	Record<ProviderKind, Readonly<{ summary: string; places: readonly RevokePlace[] }>>
> = {
	onedrive: {
		summary:
			'Microsoft keeps this app’s access to its folder after it is disconnected, until it is removed there:',
		places: [
			{
				label: 'microsoft.com/consent',
				href: 'https://microsoft.com/consent',
				accounts: 'a personal account',
			},
			{
				label: 'My Apps',
				href: 'https://myapplications.microsoft.com/',
				accounts: 'a work or school account, or ask your administrator',
			},
		],
	},
};

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
	| { kind: 'other-account'; connection: Connection };

/**
 * Confirm the connection this device is bound to, with the credential it holds.
 *
 * Much smaller than it was, because the question is now singular and definite.
 * There is no list to pick from: a credential reaches exactly one connection,
 * and the row it is filed under is that connection. So the only outcomes are
 * "still there", "gone for good", and "could not ask".
 *
 * Unbinding happens on `credential_revoked` and on nothing else. That is the
 * definite answer *about this connection* — revoked from another device, or the
 * account disconnected — and it is permanent: the server spends a credential's
 * hash for ever, so there is no state in which it starts working again. Every
 * other failure throws and the device keeps what it has, which is the whole of
 * the old reconcile race: an absence from a list was never evidence, and a
 * cached or replayed answer could unbind a live connection.
 *
 * Throws when the server cannot be asked at all: offline is not an answer.
 */
export const reconcileAccount = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>
): Promise<AccountState> => reconcileOnce(db, client, true);

const reconcileOnce = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	again: boolean
): Promise<AccountState> => {
	const since = await bindingCount(db);
	const active = await activeConnectionId(db);
	if (active === LOCAL_CONNECTION_ID) return { kind: 'none' };

	const held = await credentialFor(db, active);
	// Bound to a connection with no credential to ask about it. Nothing here can
	// reach it again — a credential cannot be re-derived, and the server will
	// never issue a second one for a connection already made — so the honest
	// thing is to stop claiming the device is connected. The notes stay.
	if (held === undefined) return settle(db, client, since, again, { kind: 'none' });

	const result = await client.withCredential(held.credential).connection();
	if (!result.ok) {
		if (result.refusal !== 'credential_revoked' && result.refusal !== 'not_found') {
			throw new Error(`the server refused to answer for this connection: ${result.refusal}`);
		}
		await forgetCredential(db, active);
		return settle(db, client, since, again, { kind: 'none' });
	}

	const connection = result.value;
	// A provider this build has no adapter for: a newer Worker in front of an
	// older cached app. Not a reason to unbind — the connection is real and the
	// next build will sync it — so the rows stay where they are and nothing here
	// claims to be syncing them.
	if (!CONNECTABLE.includes(connection.provider)) return { kind: 'none' };

	const applied = await rememberAccount(db, {
		provider: connection.provider,
		accountId: connection.accountId,
		ifUnchangedSince: since,
	});
	if (!applied) return retry(db, client, again);
	return { kind: 'connected', connection };
};

/** Unbind, and answer `state` — or start over if the device moved underneath. */
const settle = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	since: number,
	again: boolean,
	state: AccountState
): Promise<AccountState> =>
	(await unbindConnection(db, { ifUnchangedSince: since })) ? state : retry(db, client, again);

/**
 * The device changed connection while the server was being asked — a disconnect
 * in another tab, or a flow finishing. What came back is about a device that no
 * longer exists, so it is asked again, once.
 */
const retry = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	again: boolean
): Promise<AccountState> => {
	if (!again) throw new Error('The device changed connection while the server was being asked');
	return reconcileOnce(db, client, false);
};

/**
 * Take up the connection a flow just consented to.
 *
 * The credential was written down before the browser left for the provider
 * (`beginConnect`), so this is where it finds out what it reaches. Until the
 * server answers there is no id to file it under, which is why it is not
 * promoted in place.
 *
 * Binding is a separate decision and stays one: if the account is not the one
 * this device's notes belong to, binding would copy every note into a
 * stranger's storage, so it answers `other-account` and waits to be told
 * (`adoptAccount`). The credential is kept eitherway — the connection exists on
 * the server whether or not this device binds to it, and a credential thrown
 * away here would leave it unreachable and unrevokable from this device.
 */
export const claimConnection = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>
): Promise<AccountState> => {
	const pending = await pendingCredential(db);
	if (pending === undefined) return reconcileAccount(db, client);

	const result = await client.withCredential(pending.credential).connection();
	if (!result.ok) {
		// The flow did not finish, or finished for a credential this is not.
		// Nothing was reachable by it, so there is nothing to strand.
		await forgetCredential(db, PENDING_CREDENTIAL_ID);
		return reconcileAccount(db, client);
	}

	const connection = result.value;
	await keepCredential(db, connection.id, pending);
	if (await needsAsking(db, connection)) return { kind: 'other-account', connection };

	await bindConnection(db, {
		connectionId: connection.id,
		provider: connection.provider,
		accountId: connection.accountId,
	});
	return { kind: 'connected', connection };
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
 * Whether the device itself holds anything of the account's: a note, a notebook,
 * or a delete still owed to one of its files — which a copy would drop, and the
 * note would come back the next time the account is connected.
 *
 * The device's own rows, and only those. Another connected source's notes are
 * not in question: binding no longer moves them anywhere (`moveRowsTo` takes
 * the connection to move *from*), so counting them would stop the user with a
 * question about notes nothing was going to touch.
 */
const holdsAnything = async (db: NotesDatabase): Promise<boolean> =>
	(await db.notes
		.filter(
			(note) =>
				note.connectionId === LOCAL_CONNECTION_ID &&
				(note.deletedLocally === 0 || note.remoteId !== undefined)
		)
		.count()) > 0 ||
	(await db.folders.filter((folder) => folder.connectionId === LOCAL_CONNECTION_ID).count()) > 0;

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
 * leave the account connected there — with a live refresh token — and nothing
 * on this device able to name it.
 *
 * The credential is thrown away with the binding. There is nothing to tell the
 * server: its hash is already spent there, and spent for ever, so a copy of
 * this credential taken before now can never claim a connection of its own
 * (docs/PLAN.md §6).
 *
 * The notes stay on the device either way (`unbindConnection`). Nothing on the
 * remote is touched.
 */
export const disconnectAccount = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	connectionId: string
): Promise<DisconnectOutcome> => {
	const held = await credentialFor(db, connectionId);
	// No credential is the same position a disconnect leaves the device in, so
	// finish the job here rather than refuse: the server cannot be asked, and
	// the alternative is a binding the user cannot get rid of.
	if (held !== undefined) {
		const result = await client.withCredential(held.credential).disconnect();
		// Already gone on the server is what was asked for. So is a credential it
		// no longer honours: whatever removed it did the disconnecting.
		const done =
			result.ok || result.refusal === 'not_found' || result.refusal === 'credential_revoked';
		if (!done) return result;
	}
	await forgetCredential(db, connectionId);
	await unbindConnection(db);
	return { ok: true };
};
