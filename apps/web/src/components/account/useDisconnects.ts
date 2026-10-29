import { useCallback, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import type { NotesDatabase } from '../../store/db.js';
import { holdsTextFor } from '../../store/detached.js';
import { settleEditors } from '../../store/heldEdits.js';
import { rowsOf } from '../../store/rows.js';
import { type Seen, seenIn, type Unsynced, unsyncedIn } from '../../store/unsynced.js';
import { type LetGoInput, letGoOfSource, type LetGoResult } from '../../sync/account.js';
import type { Client } from './clients.js';
import { failureMessage, refusalMessage } from './statusWords.js';

/**
 * How long the last push before a disconnect is given, before the user is asked
 * anyway.
 *
 * A push still going is not cancelled — whatever it lands is one less thing on
 * the list — but nobody is kept waiting on a provider that is not answering,
 * and the question is the same either way: what is left when it stops.
 */
const LAST_PUSH_MS = 10_000;

const after = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Everything the dialog before a disconnect is about, gathered in the order it
 * has to be gathered in.
 *
 * The editors write first, because text inside the autosave window is in no row
 * and a list taken from the store alone would leave out the sentence just
 * typed. Then, where there is any prospect of it working, one last push: the
 * best answer to "this has not been sent" is to send it. Only then is the list
 * made, and with it the record of what the user is being shown — which is all a
 * discard may ever reach (`seenIn`).
 *
 * The notebooks the source has are part of that record even where they are not
 * listed as unsent. Letting the source go removes the sent notes that are the
 * proof a notebook was made, so a notebook that had nothing done to it reads as
 * unsent afterwards, and would otherwise look like something written since.
 */
export const prepare = async (
	database: NotesDatabase,
	connectionId: string,
	push: (() => Promise<void>) | undefined
): Promise<{ listed: Unsynced; seen: Seen; failing: boolean }> => {
	const settled = await settleEditors();
	if (push !== undefined) {
		await Promise.race([push().catch(() => undefined), after(LAST_PUSH_MS)]);
	}
	const listed = await unsyncedIn(database, connectionId);
	const standing = (await rowsOf(database.folders, connectionId).toArray()).map(
		(folder) => folder.path
	);
	return { listed, seen: seenIn(listed, standing), failing: holdsTextFor(settled, connectionId) };
};

/** A disconnect that is under way, or that the server would not or could not do. */
export interface Disconnecting {
	busy: boolean;
	problem: string | null;
	/**
	 * The device is left bound to a connection it cannot get rid of by asking.
	 * Any failure counts: a refusal and an unreachable server strand the user the
	 * same way, and the old rule — only where the credential had stopped working
	 * — now names a case that cannot happen, because a credential the server no
	 * longer honours *is* the disconnect and `disconnectAccount` finishes the job.
	 */
	stranded: boolean;
}

/**
 * What is left to say once a source has been let go — or has not been.
 *
 * `released` is the whole of what was asked for, and says nothing. The other
 * three each mean the user's answer was not carried out in full, and each names
 * something that happened while they were deciding, so none of them is a
 * failure to report as one: nothing was lost in any of them.
 */
const wentAs = (result: LetGoResult): Disconnecting | undefined => {
	if (!result.ok) {
		return { busy: false, problem: refusalMessage(result.refusal), stranded: true };
	}
	const said = (problem: string): Disconnecting => ({ busy: false, problem, stranded: false });
	switch (result.outcome) {
		case 'released':
			return undefined;
		case 'detached':
			return said(t('account.disconnect.outcome.detached'));
		case 'holding':
			return said(t('account.disconnect.outcome.holding'));
		case 'reconnected':
			return said(t('account.disconnect.outcome.reconnected'));
		case 'no-target':
			return said(t('account.disconnect.outcome.noTarget'));
		case 'unverified':
			return said(t('account.disconnect.outcome.unverified'));
		case 'nothing-to-move':
			return said(t('account.disconnect.outcome.nothingToMove'));
	}
};

/**
 * Disconnects, by the source each is for, held by the panel rather than by
 * `Connected`.
 *
 * `Connected` is keyed by source and the switcher stays live while the server
 * is being asked, so the answer can come back to an instance that has gone. Held
 * there, a failure that arrived after "Show other source" was lost: back on the
 * first source there was no error, no way to stop syncing on this device, and
 * nothing to stop a second disconnect being started on top of the first.
 *
 * Every entry names its source, from the moment the user asked — the answer can
 * take seconds, and it is about that source whatever the panel shows by then.
 */
export const useDisconnects = (database: NotesDatabase, client: Client) => {
	const [disconnects, setDisconnects] = useState<Readonly<Record<string, Disconnecting>>>({});
	// Read where a second one is refused: state as the last render saw it would
	// let two clicks in one tick both through.
	const pending = useRef(new Set<string>());

	const put = useCallback((connectionId: string, next: Disconnecting | undefined) => {
		setDisconnects(({ [connectionId]: _before, ...rest }) =>
			next === undefined ? rest : { ...rest, [connectionId]: next }
		);
	}, []);

	const disconnect = useCallback(
		(connectionId: string, answer: Omit<LetGoInput, 'connectionId'>): Promise<void> => {
			if (pending.current.has(connectionId)) return Promise.resolve();
			pending.current.add(connectionId);
			put(connectionId, { busy: true, problem: null, stranded: false });
			return letGoOfSource(database, client, { connectionId, ...answer })
				.then((result) => {
					put(connectionId, wentAs(result));
				})
				.catch((error: unknown) => {
					put(connectionId, {
						busy: false,
						// What was asked of whom, which is what decides which outcome
						// the message may leave open.
						problem: failureMessage(error, answer.onServer),
						stranded: true,
					});
				})
				.finally(() => {
					pending.current.delete(connectionId);
				});
		},
		[client, database, put]
	);

	return { disconnects, disconnect };
};
