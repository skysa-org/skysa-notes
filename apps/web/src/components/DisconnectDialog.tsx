import { type ReactNode, type RefObject, useEffect, useState } from 'react';

import { t } from '../i18n/t.js';
import { type ConnectedSource } from '../store/connection.js';
import { type NoteRecord, noteRef } from '../store/db.js';
import { downloadProblem, hasUnsentDownload } from '../store/exportNotes.js';
import { countedFolders, countOf, isEmpty, type Unsynced } from '../store/unsynced.js';
import { type UnsentAnswer } from '../sync/account.js';
import { canMove, leftBehind, MoveUnsent } from './MoveUnsent.js';

/**
 * What the user is asked before a source is disconnected.
 *
 * The rule it exists for: they are asked **before** anything happens, not told
 * afterwards (docs/ARCHITECTURE.md §10). Nothing is sent to the server until this has
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
	/**
	 * How many other devices are signed in to the account and stay so, or
	 * `undefined` where the server has not said. Disconnecting signs this
	 * device out and no other, and the last one out disconnects the account.
	 * Not asked for at all with `onServer: false`, which tells the server
	 * nothing.
	 */
	others: number | undefined;
	/** Whether the server is asked, rather than this device stopping alone. */
	onServer: boolean;
	/**
	 * Where the provider leaves the app's access behind, where it does. Said
	 * only where the account may be about to go: with other devices still in
	 * it, the app's access is meant to stay.
	 */
	leftAtProvider: ReactNode;
	download: (listed: Unsynced) => Promise<void>;
	onAnswer: (answer: UnsentAnswer) => void;
	onCancel: () => void;
	/** The parent moves the focus here, and keeps it off a button that has gone. */
	cancelRef: RefObject<HTMLButtonElement | null>;
}

/**
 * "3 notes not yet sent · 1 rename · 2 deletes", in the order they matter. The
 * notebooks by the same rule the headline counts by (`countedFolders`), so the
 * two cannot disagree — a breakdown adding up to more than the number above it
 * is the user being told they are about to lose something they are not.
 */
const summary = (listed: Unsynced): string =>
	[
		...(listed.notes.length > 0
			? [t('unsent.counted.notesNotSent', { count: listed.notes.length })]
			: []),
		...(listed.renames.length > 0
			? [t('unsent.counted.renames', { count: listed.renames.length })]
			: []),
		...(listed.deletes.length > 0
			? [t('unsent.counted.deletes', { count: listed.deletes.length })]
			: []),
		...(countedFolders(listed).length > 0
			? [t('unsent.counted.notebooks', { count: countedFolders(listed).length })]
			: []),
		...(listed.rmdirs.length > 0
			? [t('unsent.counted.notebookDeletes', { count: listed.rmdirs.length })]
			: []),
		...(listed.files.length > 0
			? [t('unsent.counted.filesNotYetUploaded', { count: listed.files.length })]
			: []),
	].join(' · ');

/**
 * Why the last push could not clear this, where the user should wait instead:
 * said after the headline.
 */
const why = (stopped: 'offline' | 'blocked'): string =>
	stopped === 'offline' ? t('unsent.disconnect.offline') : t('unsent.disconnect.blocked');

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
	if (listed.unverified) return t('unsent.disconnect.unverified', { provider: label });
	return t('unsent.disconnect.headline', { count: countOf(listed), provider: label });
};

/**
 * What becomes of the account, which depends on who else is in it: other
 * devices keep syncing, and the last one out takes the account with it. Said
 * before the user answers, since the two are different things to agree to.
 */
const elsewhere = (others: number | undefined): string => {
	if (others === undefined) return t('unsent.disconnect.others.unknown');
	if (others === 0) return t('unsent.disconnect.others.none');
	// One is "the other device", which is not a count, and so its own message
	// rather than a plural's `one`: in some languages that is 21 as well.
	return others === 1
		? t('unsent.disconnect.others.single')
		: t('unsent.disconnect.others.several', { count: others });
};

/**
 * The second step's question. A single note is "this note", which is not a
 * count, and so its own message rather than a plural's `one`: in some
 * languages that is 21 as well.
 */
const discardQuestion = (listed: Unsynced, label: string): string => {
	const count = listed.notes.length;
	if (count === 0) return t('unsent.discard.unsentOnly');
	if (listed.unverified) {
		return count === 1
			? t('unsent.disconnect.discardNoteUnverified', { provider: label })
			: t('unsent.disconnect.discardNotesUnverified', { count, provider: label });
	}
	return count === 1
		? t('unsent.disconnect.discardNote')
		: t('unsent.disconnect.discardNotes', { count });
};

const Titles = ({ notes }: { notes: readonly NoteRecord[] }) => {
	const named = notes.slice(0, NAMED);
	const rest = notes.slice(NAMED);
	if (named.length === 0) return null;
	return (
		<>
			<ul aria-label={t('unsent.disconnect.notes')}>
				{named.map((note) => (
					<li key={noteRef(note)}>{note.title}</li>
				))}
			</ul>
			{rest.length > 0 && (
				<details>
					<summary>{t('unsent.disconnect.more', { count: rest.length })}</summary>
					<ul aria-label={t('unsent.disconnect.rest')}>
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
	others,
	onServer,
	leftAtProvider,
	download,
	onAnswer,
	onCancel,
	cancelRef,
}: DisconnectDialogProps) => {
	const [discarding, setDiscarding] = useState(false);
	// Why the last download did not happen. Said here, beside the button: one
	// that silently does nothing is a user who goes on to discard, thinking
	// they have a copy.
	const [failed, setFailed] = useState<string | null>(null);
	const save = () => {
		setFailed(null);
		void download(listed).catch((error: unknown) => {
			setFailed(downloadProblem(error));
		});
	};
	const failure = failed !== null && (
		<p className="muted" role="alert">
			{failed}
		</p>
	);
	const named = displayName === null ? label : `${label} · ${displayName}`;
	// Nothing about other devices without the server: it is not asked, so the
	// account is wherever it was.
	const after = onServer ? (
		<>
			<p className="muted">{elsewhere(others)}</p>
			{(others === undefined || others === 0) && leftAtProvider}
		</>
	) : null;
	useEffect(() => {
		// The button that was pressed has gone with the step, and the focus would
		// fall to the page — where Escape reaches nothing, since it is listened for
		// on the panel. Only on the way in: the parent put the focus here when the
		// question opened, and may have decided not to.
		if (discarding) cancelRef.current?.focus();
	}, [discarding, cancelRef]);

	const cancel = (
		<button ref={cancelRef} type="button" className="ghost" onClick={onCancel} disabled={busy}>
			{t('common.cancel')}
		</button>
	);

	// Nothing here that the remote lacks: there is nothing to decide, and the
	// question is only whether to disconnect.
	if (isEmpty(listed)) {
		return (
			<div className="account-confirm" role="group" aria-label={t('unsent.disconnect.group')}>
				<p className="muted">
					{t('unsent.disconnect.plain', { name: named, provider: label })}
				</p>
				{after}
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						onAnswer('discard');
					}}
				>
					{t('unsent.disconnect.confirm')}
				</button>
				{cancel}
			</div>
		);
	}

	if (discarding) {
		return (
			<div className="account-confirm" role="group" aria-label={t('unsent.discard.forGood')}>
				<p>{discardQuestion(listed, label)}</p>
				<Titles notes={listed.notes} />
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						onAnswer('discard');
					}}
				>
					{t('unsent.discard.forGood')}
				</button>
				<button type="button" disabled={busy || !hasUnsentDownload(listed)} onClick={save}>
					{t('unsent.discard.downloadFirst')}
				</button>
				{failure}
				{cancel}
			</div>
		);
	}

	const leaves = canMove(listed, targets) ? leftBehind(listed, label) : null;
	return (
		<div className="account-confirm" role="group" aria-label={t('unsent.disconnect.group')}>
			<p className="muted">
				{headline(listed, label)}
				{stopped !== null && ` ${why(stopped)}`}
			</p>
			<p className="muted">{summary(listed)}</p>
			<Titles notes={listed.notes} />
			{leaves !== null && (
				<p className="muted">
					{t('unsent.disconnect.movingLeaves', { leftBehind: leaves })}
				</p>
			)}
			{/*
			 * The one thing here that is about a note's text rather than a row:
			 * an editor is holding something the store would not take, so neither
			 * the list nor a discard is about the whole of what the user wrote.
			 */}
			{failing && (
				<p className="muted" role="alert">
					{t('unsent.cannotList')}
				</p>
			)}
			{after}
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
				{t('unsent.disconnect.discardThem')}
			</button>
			<button type="button" disabled={busy || !hasUnsentDownload(listed)} onClick={save}>
				{t('unsent.disconnect.downloadThem')}
			</button>
			{failure}
			{cancel}
		</div>
	);
};
