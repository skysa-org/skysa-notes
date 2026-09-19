import { useEffect, useRef, useState } from 'react';

import { type ConnectedSource } from '../store/connection.js';
import { LOCAL_CONNECTION_ID } from '../store/db.js';
import { movable, type Unsynced } from '../store/unsynced.js';
import { connectedName } from '../sync/account.js';

/**
 * Taking what one source never sent into another connected source.
 *
 * The one place in the app where a user's writing crosses from one storage
 * account into another, so it is two steps and both of them name the account it
 * is going to (docs/PLAN.md §10). The first offers it; the second says exactly
 * what will be in each account afterwards, including the two things people are
 * entitled to be surprised by — a note that was pushed once is left behind in
 * an older version as well as copied, and an unsent rename or delete is not
 * carried at all, because it is about a file only the old account has.
 *
 * Shared by the dialog before a disconnect and by a detached source's panel:
 * the same act, reached from either side of the same decision.
 */

export interface MoveUnsentProps {
	/** What the source holds, as the user was shown it. */
	listed: Unsynced;
	/** What the source being left is called, for the sentences about it. */
	from: string;
	/** The live sources it could go to. Nothing is offered where there are none. */
	targets: readonly ConnectedSource[];
	/** Something is already under way; nothing here may start a second one. */
	busy: boolean;
	/** The user cannot answer for this source yet — text the store would not take. */
	disabled: boolean;
	onMove: (target: string) => void;
}

/**
 * Where one source's unsent work could go: every *other* source that is
 * connected. Not a detached one, which cannot send what it is handed either,
 * and not the device's own pile, which nothing shows while a source is
 * connected — a note put there would be one the user cannot find.
 */
export const otherLiveSources = (
	sources: readonly ConnectedSource[] | undefined,
	connectionId: string
): ConnectedSource[] =>
	(sources ?? []).filter(
		(source) =>
			source.connectionId !== connectionId &&
			source.connectionId !== LOCAL_CONNECTION_ID &&
			source.detached === undefined
	);

const counted = (count: number, one: string, many: string): string =>
	`${String(count)} ${count === 1 ? one : many}`;

/**
 * What is *not* moved, and where it stays. An unsent rename and an unsent
 * delete are each about a file that only the account being left has: the rename
 * leaves it under its old name, in full, and the delete can never be sent at
 * all once the account is disconnected. Neither means anything in another
 * account, so neither is carried — and a user who is not told that will find
 * the file still there and think something went wrong.
 */
export const leftBehind = (listed: Unsynced, from: string): string | null => {
	const [deletes, renames] = [listed.deletes.length, listed.renames.length];
	const parts = [
		...(deletes > 0 ? [counted(deletes, 'delete', 'deletes')] : []),
		...(renames > 0 ? [counted(renames, 'rename', 'renames')] : []),
	];
	if (parts.length === 0) return null;
	const one = parts.length === 1 && deletes + renames === 1;
	return `${parts.join(' and ')} ${one ? 'was' : 'were'} never sent; ${from} keeps those files as they are.`;
};

/** "2 notes", or "2 notes and 1 notebook" where notebooks are going too. */
const going = (listed: Unsynced): string => {
	const notes = counted(listed.notes.length, 'note', 'notes');
	return listed.folders.length === 0
		? notes
		: `${notes} and ${counted(listed.folders.length, 'notebook', 'notebooks')}`;
};

/**
 * Notes the account being left already has a file for, in an older version. The
 * copy is an edit to that file that was never sent, so moving it leaves the old
 * version where it is and writes the new one into the other account: the same
 * note, in two accounts, and said so rather than quietly done.
 */
const alsoThere = (listed: Unsynced): number =>
	listed.notes.filter((note) => note.remoteId !== undefined).length;

export const MoveUnsent = ({ listed, from, targets, busy, disabled, onMove }: MoveUnsentProps) => {
	const [chosen, setChosen] = useState<string | undefined>(targets[0]?.connectionId);
	const [confirming, setConfirming] = useState(false);
	const cancelButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// The safe answer is the one a stray Enter gives, as everywhere else the
		// app asks something it cannot take back.
		if (confirming) cancelButton.current?.focus();
	}, [confirming]);

	const target = targets.find((source) => source.connectionId === chosen) ?? targets[0];
	if (target === undefined) return null;
	const into = connectedName(target);
	const count = movable(listed);
	const older = alsoThere(listed);
	const also = leftBehind(listed, from);

	if (!confirming) {
		return (
			<>
				{targets.length > 1 && (
					<fieldset className="account-targets">
						<legend>Which source</legend>
						{targets.map((source) => (
							<label key={source.connectionId}>
								<input
									type="radio"
									name="move-target"
									value={source.connectionId}
									checked={source.connectionId === target.connectionId}
									onChange={() => {
										setChosen(source.connectionId);
									}}
								/>
								{connectedName(source)}
							</label>
						))}
					</fieldset>
				)}
				<button
					type="button"
					disabled={busy || disabled}
					onClick={() => {
						setConfirming(true);
					}}
				>
					{`Move ${String(count)} notes to ${into}…`}
				</button>
			</>
		);
	}

	return (
		<div className="account-confirm" role="group" aria-label="Move to another source">
			<p>
				{`These ${going(listed)} will be uploaded to ${into}.`}
				{older > 0 &&
					` ${String(older)} of them also ${older === 1 ? 'exists' : 'exist'} in ${from} in an older version, which stays there.`}
				{also !== null && ` ${also}`}
			</p>
			<button
				type="button"
				disabled={busy}
				onClick={() => {
					onMove(target.connectionId);
				}}
			>
				Move them
			</button>
			<button
				ref={cancelButton}
				type="button"
				className="ghost"
				disabled={busy}
				onClick={() => {
					setConfirming(false);
				}}
			>
				Cancel
			</button>
		</div>
	);
};
