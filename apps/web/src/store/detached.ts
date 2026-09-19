import {
	type Detached,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	type SyncStateRecord,
} from './db.js';

/**
 * A source the device no longer reaches, kept for what it never sent
 * (`SyncStateRecord.detached`). The two halves that more than one module needs:
 * what such a row carries, and making one for notes that have none.
 *
 * Apart from `store/connection.ts`, which does the detaching, because
 * `store/notes.ts` needs the second half and `connection.ts` already imports
 * from there.
 */

/**
 * `state`, as a detached source's row.
 *
 * What says whose the notes are is kept — provider, account, the name the
 * server last gave it, and the install's client id — since that is how the user
 * tells which source is in question and how a reconnect knows the rows are
 * going home. `resumeUnverified` is kept as well: a resumed source nobody had
 * checked yet is still one whose clean rows are a memory and not a fact
 * (`store/unsynced.ts`), and dropping the flag would let a discard count them
 * as safely on the remote.
 *
 * Everything that reaches the remote goes: the cursor, so the first pull after
 * a reconnect is a full scan that brings back what was removed here; the root,
 * which belongs to a folder that may be another one by then; and the access
 * token, which is a live key to the account and has no business outliving the
 * connection. A row already detached keeps the time it first was.
 */
export const detachedFrom = (
	state: SyncStateRecord,
	reason: Detached['reason'],
	at: number
): SyncStateRecord => ({
	connectionId: state.connectionId,
	...(state.provider === undefined ? {} : { provider: state.provider }),
	...(state.accountId === undefined ? {} : { accountId: state.accountId }),
	...(state.displayName === undefined ? {} : { displayName: state.displayName }),
	clientId: state.clientId,
	...(state.resumeUnverified === true ? { resumeUnverified: true } : {}),
	detached: state.detached ?? { at, reason },
});

/**
 * Write onto a source's row only while the device still syncs it.
 *
 * For what a sync run learns on its way — a token, the root, when it last
 * pulled — which can land after the source was let go. A row that has gone
 * must not come back, which `update` alone would see to; a row that is still
 * there *detached* must not be handed a live access token or a root either,
 * and only reading it first can tell.
 */
export const updateLive = (
	db: NotesDatabase,
	connectionId: string,
	change: (state: SyncStateRecord) => SyncStateRecord
): Promise<void> =>
	db.transaction('rw', db.syncState, async () => {
		const state = await db.syncState.get(connectionId);
		if (state === undefined || state.detached !== undefined) return;
		await db.syncState.put(change(state));
	});

/**
 * Make sure a note written under `connectionId` has a source to be seen in.
 *
 * For a save that arrives after the source's row has gone — another tab let it
 * go, with nothing unsent at the time, and this tab's editor was still holding
 * a keystroke. The text is kept where it was typed, under a row that says
 * `interrupted`, rather than in the device's own pile, which nothing shows
 * while any source is connected, or in whichever source happens to be in front,
 * which is another account's storage. The row names no provider, because
 * nothing here knows it any more: the panel calls it a disconnected source and
 * offers a download.
 *
 * Inside the caller's transaction, which has to cover `syncState`. A source
 * that is there — live or detached — is left exactly as it is.
 */
export const ensureDetached = async (
	db: Pick<NotesDatabase, 'syncState'>,
	connectionId: string
): Promise<void> => {
	if (connectionId === LOCAL_CONNECTION_ID) return;
	if ((await db.syncState.get(connectionId)) !== undefined) return;
	const install = (await db.syncState.toCollection().first())?.clientId;
	await db.syncState.put({
		connectionId,
		clientId: install ?? crypto.randomUUID(),
		detached: { at: Date.now(), reason: 'interrupted' },
	});
};
