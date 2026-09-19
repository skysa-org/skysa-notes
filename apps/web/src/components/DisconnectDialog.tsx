import { type ReactNode, type RefObject, useEffect, useState } from 'react';

import { type ConnectedSource } from '../store/connection.js';
import { type NoteRecord, noteRef } from '../store/db.js';
import { countedFolders, countOf, isEmpty, type Unsynced } from '../store/unsynced.js';
import { type UnsentAnswer } from '../sync/account.js';
import { canMove, leftBehind, MoveUnsent } from './MoveUnsent.js';

/**
 * What the user is asked before a source is disconnected.
 *
 * The rule it exists for: they are asked **before** anything happens, not told
 * afterwards (docs/PLAN.md §10). Nothing is sent to the server until this has
 * an answer, so cancelling has changed nothing anywhere — and the answer is
 * about a list they were actually shown, which is the only thing a discard may
 * reach (`releaseConnection`'s `seen`).
 *
 * With nothing unsent there is nothing to decide and it is the plain confirm it
 * always was. With something unsent the choice is the owner's four: move it to
 * another connected source, download it, discard it by name, or cancel — and on
 * an only source, the last three. Cancel has the focus in every case, and in
 * every step of every case: the button that was pressed goes with the step it
 * belonged to, and focus left on the page is a user who cannot press Escape.
 *
 * Moving is not offered at all where it would be a promise this cannot keep —
 * nowhere to move to, nothing of the kind a move takes, or a source whose files
 * have not been checked against its remote yet, where everything it holds is
 * listed (`canMove`). The last of those is also the one case where the headline
 * is about why the list looks the way it does rather than about what is on it.
 */

/** How many notes are named before the rest go behind a disclosure. */
const NAMED = 5;

export interface DisconnectDialogProps {
	/** The provider, as the user knows it. */
	label: string;
	/** The account's name, where the server has said one. */
	displayName: string | null;
	/** What the source holds that its remote has not been sent, as it stood. */
	listed: Unsynced;
	/** The other live sources, which its unsent work could go to instead. */
	targets: readonly ConnectedSource[];
	/**
	 * A save of this source's that the store would not take. Nothing may be
	 * moved or discarded while that is true: the rows are not the whole of what
	 * the user wrote, so the list is not the whole of what would go.
	 */
	failing: boolean;
	/** Why nothing here can be sent right now, where something is in the way. */
	stopped: 'offline' | 'blocked' | null;
	busy: boolean;
	/** Where the provider leaves the app's access behind, where it does. */
	leftAtProvider: ReactNode;
	download: (notes: readonly NoteRecord[]) => void;
	onAnswer: (answer: UnsentAnswer) => void;
	onCancel: () => void;
	/** The parent moves the focus here, and keeps it off a button that has gone. */
	cancelRef: RefObject<HTMLButtonElement | null>;
}

const counted = (count: number, one: string, many: string): string =>
	`${String(count)} ${count === 1 ? one : many}`;

/**
 * "3 notes not yet sent · 1 rename · 2 deletes", in the order they matter. The
 * notebooks by the same rule the headline counts by (`countedFolders`), so the
 * two cannot disagree — a breakdown adding up to more than the number above it
 * is the user being told they are about to lose something they are not.
 */
const summary = (listed: Unsynced): string =>
	[
		...(listed.notes.length > 0
			? [`${counted(listed.notes.length, 'note', 'notes')} not yet sent`]
			: []),
		...(listed.renames.length > 0 ? [counted(listed.renames.length, 'rename', 'renames')] : []),
		...(listed.deletes.length > 0 ? [counted(listed.deletes.length, 'delete', 'deletes')] : []),
		...(countedFolders(listed).length > 0
			? [counted(countedFolders(listed).length, 'notebook', 'notebooks')]
			: []),
		...(listed.rmdirs.length > 0
			? [counted(listed.rmdirs.length, 'notebook delete', 'notebook deletes')]
			: []),
	].join(' · ');

/** Why the last push could not clear this, where the user should wait instead. */
const WHY: Record<'offline' | 'blocked', string> = {
	offline: 'this device is offline',
	blocked: 'a change has been refused too many times',
};

/**
 * The headline, which has to be true of the list underneath it.
 *
 * Normally that list is what this device did and the remote never heard: "n
 * changes … have not reached X". But a source resumed from an earlier bind and
 * not yet checked against its remote counts *everything live in it* as unsent
 * (`Unsynced.unverified`, and `verifyResume` is what settles it), because
 * "clean, with a file id" is a memory until somebody has looked. Then the list
 * is the whole library, "have not reached" is simply false, and the honest
 * thing is to say why it looks like that and that waiting is the answer.
 */
const headline = (listed: Unsynced, label: string): string => {
	if (listed.unverified) {
		return `Everything this device holds for ${label} is listed below. This source was connected again and its files have not been checked against ${label} yet, so nothing here can be told apart from work that was never sent. Most of it is probably already there. Cancel, and connecting again while this device is online settles it.`;
	}
	return `${counted(countOf(listed), 'change', 'changes')} on this device ${countOf(listed) === 1 ? 'has' : 'have'} not reached ${label}, and cannot once it is disconnected.`;
};

const Titles = ({ notes }: { notes: readonly NoteRecord[] }) => {
	const named = notes.slice(0, NAMED);
	const rest = notes.slice(NAMED);
	if (named.length === 0) return null;
	return (
		<>
			<ul aria-label="Notes that have not been sent">
				{named.map((note) => (
					<li key={noteRef(note)}>{note.title}</li>
				))}
			</ul>
			{rest.length > 0 && (
				<details>
					<summary>{`… and ${String(rest.length)} more`}</summary>
					<ul aria-label="The rest of the notes that have not been sent">
						{rest.map((note) => (
							<li key={noteRef(note)}>{note.title}</li>
						))}
					</ul>
				</details>
			)}
		</>
	);
};

export const DisconnectDialog = ({
	label,
	displayName,
	listed,
	targets,
	failing,
	stopped,
	busy,
	leftAtProvider,
	download,
	onAnswer,
	onCancel,
	cancelRef,
}: DisconnectDialogProps) => {
	const [discarding, setDiscarding] = useState(false);
	const named = displayName === null ? label : `${label} · ${displayName}`;
	useEffect(() => {
		// The button that was pressed has gone with the step, and the focus would
		// fall to the page — where Escape reaches nothing, since it is listened for
		// on the panel. Only on the way in: the parent put the focus here when the
		// question opened, and may have decided not to.
		if (discarding) cancelRef.current?.focus();
	}, [discarding, cancelRef]);

	const cancel = (
		<button ref={cancelRef} type="button" className="ghost" onClick={onCancel} disabled={busy}>
			Cancel
		</button>
	);

	// Nothing here that the remote lacks: there is nothing to decide, and the
	// question is only whether to disconnect.
	if (isEmpty(listed)) {
		return (
			<div className="account-confirm" role="group" aria-label="Disconnect">
				<p className="muted">
					{`Disconnect ${named}? Its notes are removed from this device. Nothing is deleted from ${label}; connect it again to get them back.`}
				</p>
				{leftAtProvider}
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						onAnswer('discard');
					}}
				>
					Disconnect
				</button>
				{cancel}
			</div>
		);
	}

	if (discarding) {
		return (
			<div className="account-confirm" role="group" aria-label="Discard for good">
				<p>
					{listed.notes.length === 0
						? 'Discard what this source never sent?'
						: `Discard ${listed.notes.length === 1 ? 'this note' : `these ${String(listed.notes.length)} notes`}?${
								listed.unverified
									? ` Most are probably still in ${label}, but this device has not been able to check, so it cannot promise it. This cannot be undone.`
									: ' They exist nowhere else. This cannot be undone.'
							}`}
				</p>
				<Titles notes={listed.notes} />
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						onAnswer('discard');
					}}
				>
					Discard for good
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
				{cancel}
			</div>
		);
	}

	return (
		<div className="account-confirm" role="group" aria-label="Disconnect">
			<p className="muted">
				{headline(listed, label)}
				{stopped !== null &&
					` They cannot be sent right now (${WHY[stopped]}). Cancel and try again later to keep them.`}
			</p>
			<p className="muted">{summary(listed)}</p>
			<Titles notes={listed.notes} />
			{canMove(listed, targets) && leftBehind(listed, label) !== null && (
				<p className="muted">{`Moving takes the notes, not the rest: ${leftBehind(listed, label) ?? ''}`}</p>
			)}
			{/*
			 * The one thing here that is about a note's text rather than a row:
			 * an editor is holding something the store would not take, so neither
			 * the list nor a discard is about the whole of what the user wrote.
			 */}
			{failing && (
				<p className="muted" role="alert">
					A note here has text that could not be saved yet, so it cannot be listed. Copy
					it somewhere safe first; the note says how.
				</p>
			)}
			{leftAtProvider}
			<MoveUnsent
				listed={listed}
				from={label}
				targets={targets}
				busy={busy}
				disabled={failing}
				onMove={(moveTo) => {
					onAnswer({ moveTo });
				}}
			/>
			<button
				type="button"
				disabled={busy || failing}
				onClick={() => {
					setDiscarding(true);
				}}
			>
				Discard them…
			</button>
			<button
				type="button"
				disabled={busy || listed.notes.length === 0}
				onClick={() => {
					download(listed.notes);
				}}
			>
				Download them
			</button>
			{cancel}
		</div>
	);
};
