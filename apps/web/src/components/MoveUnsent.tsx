import { useEffect, useRef, useState } from 'react';

import { type ConnectedSource } from '../store/connection.js';
import { LOCAL_CONNECTION_ID } from '../store/db.js';
import { countedFolders, movable, type Unsynced } from '../store/unsynced.js';
import { connectedName, sourceName } from '../sync/account.js';

/**
 * Taking what one source never sent into another connected source.
 *
 * The one place in the app where a user's writing crosses from one storage
 * account into another, so it is two steps and both of them name the account it
 * is going to (docs/ARCHITECTURE.md §10). The first offers it; the second says exactly
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
	/**
	 * The list handed back is the one the second step was about, held still while
	 * it was read: a caller whose `listed` comes from a live query would otherwise
	 * act on whatever another tab had made of it by the time the button was
	 * pressed, which is not what the user said yes to.
	 */
	onMove: (target: string, shown: Unsynced) => void;
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

/**
 * Whether moving is a thing to offer at all.
 *
 * Nowhere to put it; nothing of the kind a move takes, where all that is unsent
 * is a rename or a delete that belongs to the account being left — "Move 0
 * notes" would be a discard reached through a button that says Move; or a
 * source whose files nobody has checked against its remote yet, where
 * everything it holds is listed and a move would copy a whole synced library
 * into another account on a count known to be wrong (`Unsynced.unverified`).
 * `moveUnsyncedTo` refuses each of these too: this is what keeps the user from
 * being offered it in the first place.
 */
export const canMove = (listed: Unsynced, targets: readonly ConnectedSource[]): boolean =>
	targets.length > 0 && !listed.unverified && movable(listed) > 0;

/**
 * The account a move writes into, as the user knows it: the name the server
 * last gave it, and the provider's id for it only where there is no name.
 *
 * Live sources are named by their id everywhere else (`connectedName`), because
 * a name is written onto a row only while its source is the one in front and a
 * list would call a source one thing before it had been shown and another
 * after. That trade is about a switcher. This is the one confirm in the app
 * that writes a user's notes into another storage account, and "Dropbox ·
 * dbid:AAAA…" is not an account anybody can recognise.
 */
const targetName = (source: ConnectedSource): string => sourceName(source) ?? connectedName(source);

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

/**
 * What is going, in the user's terms: "2 notes", or "2 notes and 1 notebook"
 * where a notebook is going that is not simply one of those notes' own. Both
 * steps say it the same way, and it is the same count the panel's headline uses
 * (`countedFolders`), so nothing the user is shown disagrees with anything else.
 */
const going = (listed: Unsynced): string => {
	const notes = counted(listed.notes.length, 'note', 'notes');
	const folders = countedFolders(listed).length;
	return folders === 0 ? notes : `${notes} and ${counted(folders, 'notebook', 'notebooks')}`;
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
	/** The list the second step is about, as it stood when the user asked for it. */
	const [shown, setShown] = useState<Unsynced | null>(null);
	const confirming = shown !== null;
	const cancelButton = useRef<HTMLButtonElement>(null);
	const openButton = useRef<HTMLButtonElement>(null);
	// Not on the first render: the step is entered, not arrived at, and the
	// component mounts while the focus is wherever the user left it.
	const mounted = useRef(false);
	useEffect(() => {
		// Focus follows the step, both ways: the button that was pressed has gone,
		// and left to itself the focus falls to the page, where Escape reaches
		// nothing (`useEscape` listens on the panel). On the way in it lands on
		// Cancel, because the safe answer is the one a stray Enter gives.
		if (mounted.current) (confirming ? cancelButton : openButton).current?.focus();
		mounted.current = true;
	}, [confirming]);

	const target = targets.find((source) => source.connectionId === chosen) ?? targets[0];
	if (target === undefined || !canMove(listed, targets)) return null;
	const into = targetName(target);

	if (shown === null) {
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
								{targetName(source)}
							</label>
						))}
					</fieldset>
				)}
				<button
					ref={openButton}
					type="button"
					disabled={busy || disabled}
					onClick={() => {
						setShown(listed);
					}}
				>
					{`Move ${going(listed)} to ${into}…`}
				</button>
			</>
		);
	}

	const older = alsoThere(shown);
	const also = leftBehind(shown, from);
	return (
		<div className="account-confirm" role="group" aria-label="Move to another source">
			<p>
				{`${going(shown)} will be uploaded to ${into}.`}
				{older > 0 &&
					` ${String(older)} of them also ${older === 1 ? 'exists' : 'exist'} in ${from} in an older version, which stays there.`}
				{also !== null && ` ${also}`}
			</p>
			<button
				type="button"
				disabled={busy}
				onClick={() => {
					onMove(target.connectionId, shown);
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
					setShown(null);
				}}
			>
				Cancel
			</button>
		</div>
	);
};
