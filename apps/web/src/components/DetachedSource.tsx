import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
	connectedSources,
	type MoveOutcome,
	moveUnsyncedTo,
	releaseConnection,
} from '../store/connection.js';
import { type NoteRecord, noteRef, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import { holdsTextFor } from '../store/detached.js';
import { settleEditors } from '../store/heldEdits.js';
import { countOf, isEmpty, seenIn, type Unsynced, unsyncedIn } from '../store/unsynced.js';
import { PROVIDER_LABELS, sourceName } from '../sync/account.js';
import { MoveUnsent, otherLiveSources } from './MoveUnsent.js';
import { useEscape } from './useEscape.js';

/**
 * A source this device no longer reaches, which is still here because it holds
 * something its remote was never sent (`SyncStateRecord.detached`).
 *
 * The panel is where the user decides what becomes of that, and it offers the
 * four things that can: connect the account again, which sends it; move it into
 * another connected source; download it; or discard it. Nothing here happens on
 * its own, and the move is a separate, explicit act that names the account it
 * is going to, since it is the one thing here that crosses between two people's
 * storage (docs/PLAN.md §10).
 *
 * Discarding takes two steps, and the second one names what goes. These notes
 * are the only copies there are, so "Discard…" is not the button that does it:
 * it shows the titles, says that this cannot be undone, puts the focus on
 * Cancel, and keeps a download within reach. What the user was shown is exactly
 * what is discarded (`releaseConnection`'s `seen`): a note another tab wrote
 * meanwhile was not in the list, and stays, and so does text written since into
 * a note that was.
 */

export interface DetachedSourceProps {
	database: NotesDatabase;
	bound: SyncStateRecord;
	/** Start connecting this source's account again, where the server lets the user. */
	reconnect: ReactNode;
	/** The other sources on this device, and the way to connect another. */
	sources: ReactNode;
	/** Hand the notes to the user as a file. Injected: jsdom cannot make a blob URL. */
	download: (notes: readonly NoteRecord[]) => void;
	/**
	 * The source has gone, and this panel with it. Called for the focus, which
	 * was on a button that no longer exists: the caller puts it somewhere that
	 * still does.
	 */
	onReleased?: () => void;
	/** Something the caller has to say about how the source came to be here. */
	notice?: string | null;
}

/** "1 change", "3 changes". */
const changes = (count: number): string => (count === 1 ? '1 change' : `${String(count)} changes`);

const counted = (count: number, one: string, many: string): string =>
	`${String(count)} ${count === 1 ? one : many}`;

/** What is going besides the notes listed by title, or nothing to add. */
const alsoGoing = (unsynced: Unsynced): string | null => {
	const parts = [
		...(unsynced.renames.length > 0
			? [counted(unsynced.renames.length, 'rename', 'renames')]
			: []),
		...(unsynced.deletes.length > 0
			? [counted(unsynced.deletes.length, 'delete', 'deletes')]
			: []),
		...(unsynced.folders.length > 0
			? [counted(unsynced.folders.length, 'notebook', 'notebooks')]
			: []),
		...(unsynced.rmdirs.length > 0
			? [counted(unsynced.rmdirs.length, 'notebook delete', 'notebook deletes')]
			: []),
	];
	return parts.length === 0 ? null : `Also never sent, and also forgotten: ${parts.join(', ')}.`;
};

/**
 * A delete the source still owes is carried out on reconnecting, however long
 * that takes and whatever has been done to the file meanwhile: the delete wins
 * (docs/PLAN.md §7). Over weeks rather than seconds that is worth saying
 * plainly, with the way to withdraw it, which is Discard.
 */
const stillOwed = (unsynced: Unsynced, bound: SyncStateRecord): string | null => {
	if (unsynced.deletes.length === 0) return null;
	const where = bound.provider === undefined ? 'the account' : PROVIDER_LABELS[bound.provider];
	return unsynced.deletes.length === 1
		? `1 note deleted here will be deleted from ${where} when you reconnect, even if it has been changed there since. Discard withdraws that.`
		: `${String(unsynced.deletes.length)} notes deleted here will be deleted from ${where} when you reconnect, even if they have been changed there since. Discard withdraws that.`;
};

/**
 * A save the store would not take, found at the last moment: the note and the
 * source around it are kept rather than removed with the rest, so the text has
 * somewhere to land when it can be written.
 */
const HELD_BACK =
	'A note here has text that could not be saved, so the note and this source have been kept. Open the note and copy the text somewhere safe; the note says how.';

/**
 * What is left to say of a move, where what happened was not quite what was
 * asked for. None of them lost anything, so none is said as a failure.
 */
const wentAs = (outcome: MoveOutcome): string | null => {
	switch (outcome) {
		case 'detached':
			return 'Something was written in this source after the list was shown. It was not on the list, so it has been kept here.';
		case 'holding':
			return HELD_BACK;
		case 'reconnected':
			return 'This source was connected again meanwhile. Nothing has been moved.';
		case 'no-target':
			return 'That source is not connected any more, so nothing was moved.';
		case 'unverified':
			return 'This source has not been checked against its account yet, so what it holds cannot be told apart from work that was never sent. Nothing was moved.';
		case 'nothing-to-move':
			return 'There was nothing here to move, so nothing was moved.';
		case 'released':
			return null;
	}
};

/**
 * What the second step asks. A source can be left holding nothing — the one
 * unsent note deleted since — and then there is nothing to lose and the
 * question is only whether to take it off the list.
 */
const question = (unsynced: Unsynced): string => {
	if (isEmpty(unsynced)) return 'Remove this source from this device? Nothing in it is waiting.';
	if (unsynced.notes.length === 0) return 'Discard what this source never sent?';
	return unsynced.notes.length === 1
		? 'Discard this note?'
		: `Discard these ${String(unsynced.notes.length)} notes?`;
};

/**
 * The second step of a discard: what goes, by name, and that it goes for good.
 * The list is the one the user was shown, held still while they read it — not
 * the live one, which is what the answer is then held to (`seenIn`).
 */
const DiscardConfirm = ({
	listed,
	busy,
	download,
	cancelRef,
	onDiscard,
	onCancel,
}: {
	listed: Unsynced;
	busy: boolean;
	download: (notes: readonly NoteRecord[]) => void;
	cancelRef: RefObject<HTMLButtonElement | null>;
	onDiscard: () => void;
	onCancel: () => void;
}) => (
	<div className="account-confirm" role="group" aria-label="Discard for good">
		<p className="muted">{question(listed)}</p>
		{listed.notes.length > 0 && (
			<ul aria-label="Notes to discard">
				{listed.notes.map((note) => (
					<li key={noteRef(note)}>{note.title}</li>
				))}
			</ul>
		)}
		{alsoGoing(listed) !== null && <p className="muted">{alsoGoing(listed)}</p>}
		{!isEmpty(listed) && <p>These exist nowhere else. This cannot be undone.</p>}
		<button type="button" disabled={busy} onClick={onDiscard}>
			{isEmpty(listed) ? 'Remove' : 'Discard for good'}
		</button>
		<button
			type="button"
			disabled={busy || listed.notes.length === 0}
			onClick={() => {
				download(listed.notes);
			}}
		>
			Download them first
		</button>
		<button ref={cancelRef} type="button" className="ghost" disabled={busy} onClick={onCancel}>
			Cancel
		</button>
	</div>
);

export const DetachedSource = ({
	database,
	bound,
	reconnect,
	sources,
	download,
	onReleased,
	notice = null,
}: DetachedSourceProps) => {
	const connectionId = bound.connectionId;
	const unsynced = useLiveQuery(
		() => unsyncedIn(database, connectionId),
		[database, connectionId]
	);
	// Where what is here could go instead of waiting for an account that may
	// never come back. Live sources only: a detached one cannot send it either.
	const others = useLiveQuery(() => connectedSources(database), [database]);
	const targets = otherLiveSources(others, connectionId);
	/** The list the user is being asked about, as it stood when they asked. */
	const [listed, setListed] = useState<Unsynced | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// Focus follows the step the user is on, as in the disconnect confirm, and
	// lands on Cancel: the safe answer is the one a stray Enter gives.
	const focusNext = useRef<'cancel' | 'open' | null>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const openButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	const confirming = listed !== null;
	useEffect(() => {
		const target = focusNext.current === 'cancel' ? cancelButton : openButton;
		// Only focus that is still here to move: a user who went back to a note
		// while the editors were being settled keeps typing into the note.
		const focused = document.activeElement;
		const here =
			focused === null ||
			focused === document.body ||
			panel.current?.contains(focused) === true;
		if (focusNext.current !== null && here) target.current?.focus();
		focusNext.current = null;
	}, [confirming]);

	const name = sourceName(bound) ?? 'A source';
	const held = unsynced === undefined ? undefined : countOf(unsynced);

	const ask = () => {
		setBusy(true);
		setProblem(null);
		// The editors write first: a sentence still inside the autosave window is
		// in no row, and a list made without it would leave out the very thing
		// the user is about to be told is going for good.
		void settleEditors()
			.then(async (settled) => {
				// This source's notes only: a save failing in some other source is
				// that source's problem, and no reason to hold this one up.
				if (holdsTextFor(settled, connectionId)) {
					setProblem(
						'A note here has text that could not be saved yet, so it cannot be listed. Copy it somewhere safe first; the note says how.'
					);
					return;
				}
				focusNext.current = 'cancel';
				setListed(await unsyncedIn(database, connectionId));
			})
			.catch(() => {
				setProblem('That did not work. Nothing has been discarded.');
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const close = useCallback(() => {
		focusNext.current = 'open';
		setListed(null);
	}, []);
	useEscape(panel, confirming, close);

	/**
	 * Into another account, which is the one thing here that is not about this
	 * source alone. The list is the one the user was just shown, and the editors
	 * write once more first: a sentence typed while they were reading it is in
	 * no row, and a note that has changed since is kept rather than carried into
	 * a stranger's storage under a description that no longer fits it.
	 */
	const move = (shown: Unsynced, target: string) => {
		setBusy(true);
		setProblem(null);
		void settleEditors()
			.then(async (settled) => {
				if (holdsTextFor(settled, connectionId)) {
					setProblem(
						'A note here has text that could not be saved yet, so it cannot be moved. Copy it somewhere safe first; the note says how.'
					);
					return;
				}
				const outcome = await moveUnsyncedTo(database, {
					connectionId,
					target,
					seen: seenIn(shown),
					holding: new Set(settled.failing),
				});
				if (outcome === 'released') onReleased?.();
				setProblem(wentAs(outcome));
			})
			.catch(() => {
				setProblem('That did not work. Nothing has been moved.');
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const discard = (shown: Unsynced) => {
		setBusy(true);
		setProblem(null);
		// The editors write once more first: a sentence typed into a listed note
		// while the list was open is in no row, and would go with the row. In a
		// row, it makes the note one the list did not stand for, and it is kept.
		// What they still cannot write is named, and kept for the same reason.
		void settleEditors()
			.then((settled) =>
				releaseConnection(database, {
					connectionId,
					unsynced: 'discard',
					seen: seenIn(shown),
					holding: new Set(settled.failing),
				})
			)
			.then((outcome) => {
				if (outcome === 'detached') {
					setProblem(
						'Something was written in this source after the list was shown. It was not on the list, so it has been kept.'
					);
				}
				if (outcome === 'holding') setProblem(HELD_BACK);
				if (outcome === 'reconnected') {
					setProblem(
						'This source was connected again meanwhile. Nothing has been discarded.'
					);
				}
				if (outcome === 'released') onReleased?.();
			})
			.catch(() => {
				setProblem('That did not work. Nothing has been discarded.');
			})
			.finally(() => {
				setBusy(false);
				close();
			});
	};

	return (
		<section ref={panel} className="account" aria-label="Storage">
			<p>{name} is disconnected</p>
			{held !== undefined && (
				<p className="muted">
					{held === 0
						? 'Nothing here is waiting to be sent.'
						: `${changes(held)} here ${held === 1 ? 'was' : 'were'} never sent, and ${held === 1 ? 'is' : 'are'} kept on this device until you reconnect, download or discard ${held === 1 ? 'it' : 'them'}.`}{' '}
					Everything else of this source’s was removed from this device, and comes back
					when it is connected again.
				</p>
			)}
			{unsynced !== undefined && stillOwed(unsynced, bound) !== null && (
				<p className="muted">{stillOwed(unsynced, bound)}</p>
			)}
			{bound.provider === undefined && (
				<p className="muted">
					This device no longer knows which account it was, so it cannot be connected
					again from here.
				</p>
			)}
			{(problem ?? notice) !== null && (
				<p className="muted" role="alert">
					{problem ?? notice}
				</p>
			)}
			{reconnect}
			{listed === null && unsynced !== undefined && !isEmpty(unsynced) && (
				<MoveUnsent
					listed={unsynced}
					from={name}
					targets={targets}
					busy={busy}
					disabled={false}
					// The list the second step was about, not whatever the live query
					// has made of it since: what the user was shown is what the move
					// is held to (`seenIn`).
					onMove={(target, shown) => {
						move(shown, target);
					}}
				/>
			)}
			<button
				type="button"
				disabled={unsynced === undefined || unsynced.notes.length === 0}
				onClick={() => {
					if (unsynced !== undefined) download(unsynced.notes);
				}}
			>
				Download
			</button>
			{listed === null ? (
				<button
					ref={openButton}
					type="button"
					className="ghost"
					disabled={busy}
					onClick={ask}
				>
					Discard…
				</button>
			) : (
				<DiscardConfirm
					listed={listed}
					busy={busy}
					download={download}
					cancelRef={cancelButton}
					onDiscard={() => {
						discard(listed);
					}}
					onCancel={close}
				/>
			)}
			{sources}
		</section>
	);
};
