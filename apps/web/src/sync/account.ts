import { type ProviderKind } from '@skysa/core';

import { type ApiClient, type Connection, type Refusal } from '../api/client.js';
import { failedAt } from '../api/failure.js';
import {
	bindConnection,
	bindingCount,
	detachConnection,
	type MoveOutcome,
	moveUnsyncedTo,
	releaseConnection,
	rememberAccount,
} from '../store/connection.js';
import {
	credentialFor,
	forgetCredential,
	keepCredential,
	pendingCredential,
} from '../store/credentials.js';
import {
	activeConnectionId,
	type Detached,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	type SyncStateRecord,
} from '../store/db.js';
import { settleEditors } from '../store/heldEdits.js';
import { type Seen } from '../store/unsynced.js';

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
 * device lets the source go on a definite answer *about its own connection*
 * (`credential_revoked`: revoked from another device, or the account
 * disconnected) and on nothing else. Offline, a 5xx or a body it cannot read
 * throws, and the device keeps what it has — which is the fix for the reconcile
 * race arriving from the other side, since there is no longer a list that can
 * fail to mention a connection (docs/PLAN.md §6).
 *
 * Letting go is `detachConnection` on every path, the server's and the user's
 * alike: what the remote has leaves the device, and what it was never sent
 * stays under its own source, detached and in sight. Nobody is there to ask
 * when the server is the one that said so, which is exactly why nothing may be
 * discarded, and nothing moved into another account, on the way.
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

/**
 * A source as the device can name it without asking anyone: "Dropbox ·
 * ann@example.com". The name the server last gave, which is what the user
 * knows the account by; failing that the provider's id for it, which at least
 * tells two accounts at one provider apart; failing that the provider alone.
 * Nothing at all for a row that names no provider (`ensureDetached`), and the
 * caller finds its own words.
 */
export const sourceName = (
	source: Pick<SyncStateRecord, 'provider' | 'displayName' | 'accountId'>
): string | undefined => {
	if (source.provider === undefined) return undefined;
	const account = source.displayName ?? source.accountId;
	const provider = PROVIDER_LABELS[source.provider];
	return account === undefined ? provider : `${provider} · ${account}`;
};

/**
 * A source that is connected, named without asking anyone: the provider, and
 * the provider's own id for the account where there is one.
 *
 * Not the account's name, deliberately. That is written onto a row only when
 * the server is asked about it, which is only while the source is the one in
 * front — so naming live sources by it would call a source one thing until it
 * had been shown and another after. The id is stable and tells two accounts at
 * one provider apart, which is the whole reason these are ever named in a list.
 */
export const connectedName = (source: Pick<SyncStateRecord, 'provider' | 'accountId'>): string => {
	const provider = source.provider === undefined ? 'storage' : PROVIDER_LABELS[source.provider];
	return source.accountId === undefined ? provider : `${provider} · ${source.accountId}`;
};

export type AccountState =
	/** The connection the device is now bound to, as the server answers for it. */
	| { kind: 'connected'; connection: Connection }
	/**
	 * Nothing the server answers for: nothing connected, or a source in front
	 * that is detached, which has no credential to ask with.
	 */
	| { kind: 'none' };

/**
 * Confirm the connection this device is bound to, with the credential it holds.
 *
 * Much smaller than it was, because the question is now singular and definite.
 * There is no list to pick from: a credential reaches exactly one connection,
 * and the row it is filed under is that connection. So the only outcomes are
 * "still there", "gone for good", and "could not ask".
 *
 * Letting go happens on the two answers that are definite *about this
 * connection* — `credential_revoked` (revoked from another device, or the
 * account disconnected) and `not_found` (the connection is gone) — and on
 * nothing else. Both are permanent: the server spends a credential's hash for
 * ever, so there is no state in which it starts working again. Every other
 * failure throws and the device keeps what it has, which is the whole of the
 * old reconcile race: an absence from a list was never evidence, and a cached
 * or replayed answer could unbind a live connection.
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
	// Already let go, and kept for what it never sent. There is no credential to
	// ask with and nothing the answer could change; asking anyway would find none
	// and detach it again, on every open, for as long as it is in front.
	if ((await db.syncState.get(active))?.detached !== undefined) return { kind: 'none' };

	const held = await credentialFor(db, active);
	// Bound to a connection with no credential to ask about it. Nothing here can
	// reach it again — a credential cannot be re-derived, and the server will
	// never issue a second one for a connection already made — so the honest
	// thing is to stop claiming the device is connected.
	if (held === undefined) return settle(db, client, active, since, again);

	const result = await client.withCredential(held.credential).connection();
	if (!result.ok) {
		if (result.refusal !== 'credential_revoked' && result.refusal !== 'not_found') {
			throw new Error(`the server refused to answer for this connection: ${result.refusal}`);
		}
		await forgetCredential(db, active);
		return settle(db, client, active, since, again);
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
		displayName: connection.displayName,
		ifUnchangedSince: since,
	});
	if (!applied) return retry(db, client, again);
	return { kind: 'connected', connection };
};

/**
 * Let the source go, and answer `none` — or start over if the device moved
 * underneath. By name: the source the server was asked about, which need not be
 * the one in front by the time it has answered.
 *
 * The editors write first. Nobody chose this moment, so there may be a sentence
 * typed inside the autosave window that is in no row yet; unsaved, its note
 * would look clean, be removed with everything else the remote has, and the
 * sentence would go with it.
 */
const settle = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	connectionId: string,
	since: number,
	again: boolean
): Promise<AccountState> => {
	const applied = await letGo(db, connectionId, 'revoked', since);
	return applied ? { kind: 'none' } : retry(db, client, again);
};

/**
 * The one way out for every path: the editors write, and then the source is
 * let go with what they could not write named, so that it is kept.
 *
 * Immediately before, not merely earlier. A disconnect waits on the server,
 * the confirm is not a modal, and a sentence typed while the server was
 * thinking is held by the editor and in no row: settled before the round trip
 * and not after, its note would look clean, go with the rest of what the
 * remote has, and take the sentence with it. "The remote has the note" is not
 * "the remote has the edit".
 */
const letGo = async (
	db: NotesDatabase,
	connectionId: string,
	reason: Detached['reason'],
	ifUnchangedSince?: number
): Promise<boolean> => {
	const { failing } = await settleEditors();
	return detachConnection(db, {
		connectionId,
		reason,
		holding: new Set(failing),
		...(ifUnchangedSince === undefined ? {} : { ifUnchangedSince }),
	});
};

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
 * It binds without asking, because nothing it could take along is anyone
 * else's. The device's own pile holds only what was written before anything
 * was connected, and that belongs wherever the user first connects. The one
 * other thing a bind moves is a detached source's rows, and only into the
 * account they came from. A detached source of some *other* account stays
 * exactly where it is (`bindConnection`). There used to be a question here —
 * "these notes belong to another account; copy them in?" — and it existed for a
 * pile that a disconnect had filled with one account's notes. No disconnect
 * fills it any more.
 */
export const claimConnection = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>
): Promise<AccountState> => {
	const pending = await pendingCredential(db);
	if (pending === undefined) return reconcileAccount(db, client);

	const result = await client.withCredential(pending.credential).connection();
	if (!result.ok) {
		// Not an answer about the flow. A credential the server has never seen
		// and one whose flow is still out — consent page open in another tab —
		// are the same refusal, and throwing it away on the second is the worst
		// outcome the design has: the user consents, the server commits the
		// connection and spends the hash for ever, and this device holds no
		// plaintext for it. Unreachable, unrevokable, and holding a live refresh
		// token. A flow the user really did abandon is swept by `PENDING_TTL_MS`
		// instead, which cannot be wrong about it.
		return reconcileAccount(db, client);
	}

	const connection = result.value;
	const previous = await credentialFor(db, connection.id);
	await keepCredential(db, connection.id, pending);
	await bindConnection(db, {
		connectionId: connection.id,
		provider: connection.provider,
		accountId: connection.accountId,
		displayName: connection.displayName,
	});
	// Last, and awaited: two calls to a server are not something to put between
	// a credential kept and a device bound, where a closed tab leaves the one
	// without the other — and let go of unawaited they die with the tab, and
	// the old grant lingers after all.
	if (previous !== undefined && previous.credential !== pending.credential) {
		await retire(client, previous.credential, connection.id);
	}
	return { kind: 'connected', connection };
};

/**
 * Sign out the credential this device held for the connection before it
 * connected again.
 *
 * The new credential has just replaced it here, so nothing will present it
 * again — but the server does not know that, and its grant would sit in the
 * device list as a device that is not one, and as one more live key to the
 * account, until it idled out half a year later. Only once the new one is
 * written down, so the device never holds none.
 *
 * Best effort, and silent. Most often the old credential is why the user is
 * connecting again — revoked, or expired — and the server refuses it: there is
 * nothing to retire. Offline, the grant idles out as it would have.
 */
const retire = async (
	client: Pick<ApiClient, 'withCredential'>,
	credential: string,
	connectionId: string
): Promise<void> => {
	const old = client.withCredential(credential);
	await old
		.connection()
		.then(async (seen) => {
			// Asked, not assumed: the grant's id is the server's, and a credential
			// filed under the wrong connection must not sign out somebody else's.
			if (seen.ok && seen.value.id === connectionId)
				await old.revokeGrant(seen.value.grantId);
		})
		.catch(() => undefined);
};

export type DisconnectOutcome = { ok: true } | { ok: false; refusal: Refusal };

/**
 * Disconnect on the server, then here. Only in that order, and only once the
 * server has let go: letting go here first and failing to reach the server
 * would leave the account connected there — with a live refresh token — and
 * nothing on this device able to name it.
 *
 * The credential is thrown away with the binding. There is nothing to tell the
 * server: its hash is already spent there, and spent for ever, so a copy of
 * this credential taken before now can never claim a connection of its own
 * (docs/PLAN.md §6).
 *
 * Here, the source's synced notes leave the device and anything it was never
 * sent stays under it, detached (`detachConnection`). Nothing on the remote is
 * touched. The editors write before the server is asked, so that nothing waits
 * on a round trip to reach a row, and again once it has answered (`letGo`),
 * for what was typed while it was being asked — which is what decides whether
 * a note's row is the whole of it.
 */
export const disconnectAccount = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	connectionId: string
): Promise<DisconnectOutcome> => {
	await settleEditors();
	const held = await credentialFor(db, connectionId);
	// No credential is the same position a disconnect leaves the device in, so
	// finish the job here rather than refuse: the server cannot be asked, and
	// the alternative is a binding the user cannot get rid of.
	if (held !== undefined) {
		// The one thing here that leaves the device, and said so, because a
		// caller reporting a failure has two different true things to say and no
		// other way to tell which (`api/failure.ts`).
		const result = await failedAt(
			'server',
			client.withCredential(held.credential).disconnect()
		);
		// Already gone on the server is what was asked for. So is a credential it
		// no longer honours: whatever removed it did the disconnecting.
		const done =
			result.ok || result.refusal === 'not_found' || result.refusal === 'credential_revoked';
		if (!done) return result;
	}
	await forgetCredential(db, connectionId);
	// By name, not "whichever is in front": the answer can arrive after the user
	// has turned to another source, and letting that one go would drop a
	// connection nobody asked about while the one that was meant stays bound.
	await letGo(db, connectionId, 'disconnected');
	return { ok: true };
};

/**
 * Stop syncing a source on this device without the server's say: the way out
 * when it will not, or cannot, disconnect. Nothing is asked of the server and
 * nothing on it is touched, so the connection may well live on there — which
 * the panel has already said. Here it is the same letting go as any other.
 */
export const stopSyncingHere = async (db: NotesDatabase, connectionId: string): Promise<void> => {
	await letGo(db, connectionId, 'disconnected');
};

/** What the user answered about the work the remote was never sent. */
export type UnsentAnswer = 'discard' | { moveTo: string };

export interface LetGoInput {
	connectionId: string;
	/** Which they chose, having been shown what it is about. */
	unsent: UnsentAnswer;
	/** What they were shown, as it stood (`seenIn` in `store/unsynced.ts`). */
	seen: Seen;
	/**
	 * Whether to ask the server to disconnect the account first. `false` is
	 * "stop syncing on this device": the same question, the same answer, and no
	 * server — for a connection it will not or cannot let go of.
	 */
	onServer: boolean;
}

export type LetGoResult = { ok: false; refusal: Refusal } | { ok: true; outcome: MoveOutcome };

/**
 * A source let go for good, with the user's answer about what it never sent
 * carried out in the same breath.
 *
 * The order is the whole of it. The server goes first, for the reason
 * `disconnectAccount` gives; and nothing is asked of it until the user has
 * answered, so a dialog they cancel has changed nothing anywhere. The detach
 * that follows keeps what was never sent (`detachConnection`) and the answer
 * then decides what becomes of it, in one transaction, against the list they
 * were shown rather than against whatever the store says by then.
 *
 * A server that refuses leaves the device exactly as it was, answer and all:
 * the panel says so and offers to stop syncing here instead, which is this
 * again with `onServer: false`.
 *
 * The editors write once more immediately before the release, and what they
 * still cannot write is carried into it (`holding`). The detach just before
 * kept those rows so unsavable text would have somewhere to land; the release
 * would otherwise take them straight back out. And the dialog's own guard was
 * computed before the question was asked, which a save that begins failing
 * while the user is reading it walks straight past.
 *
 * A failure says how far it got (`api/failure.ts`). Everything here except the
 * disconnect is this device's own work, and a caller told only that something
 * threw would have to answer "the server cannot be reached" for a store that
 * refused a write with no server near it — which is every failure of `onServer:
 * false`, where nothing is asked of the server at all.
 */
export const letGoOfSource = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	input: LetGoInput
): Promise<LetGoResult> => failedAt('device', releasing(db, client, input));

const releasing = async (
	db: NotesDatabase,
	client: Pick<ApiClient, 'withCredential'>,
	input: LetGoInput
): Promise<LetGoResult> => {
	const { connectionId, seen, unsent } = input;
	if (input.onServer) {
		const disconnected = await disconnectAccount(db, client, connectionId);
		if (!disconnected.ok) return disconnected;
	} else {
		await stopSyncingHere(db, connectionId);
	}
	const { failing } = await settleEditors();
	const holding = new Set(failing);
	const outcome =
		unsent === 'discard'
			? await releaseConnection(db, { connectionId, unsynced: 'discard', seen, holding })
			: await moveUnsyncedTo(db, {
					connectionId,
					target: unsent.moveTo,
					seen,
					holding,
				});
	return { ok: true, outcome };
};
