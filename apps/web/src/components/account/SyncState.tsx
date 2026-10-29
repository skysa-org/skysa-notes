import { isVaultPath } from '@skysa/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';

import type { InstanceConfig } from '../../api/client.js';
import { answer, type Asked } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import { noteLink } from '../../routes/place.js';
import type { NotesDatabase, SyncStateRecord } from '../../store/db.js';
import { getNote } from '../../store/notes.js';
import { isTombstone } from '../../store/rowStates.js';
import { CONNECTABLE } from '../../sync/account.js';
import { useSyncStatus } from '../../sync/runtime.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import { needsReconnect } from '../../sync/status.js';
import { ConnectButton } from '../ConnectButton.js';
import { DialogActions, InlineDialog } from '../ui/Dialog.js';
import type { Client, Sync } from './clients.js';
import { conflictMessage, statusMessage } from './statusWords.js';
import { UnreadableNotice } from './SyncNotices.js';

/**
 * The note a stuck op is about, when it is still here. A stuck `delete` is
 * about a note the user has already deleted — its row is a tombstone — and
 * offering to open that would be offering nothing. Nor a password in the
 * vault (docs/ARCHITECTURE.md §7, "Passwords in the vault"), which the link
 * would open in the note editor, its fence's words and all.
 */
const StuckNote = ({ database, noteId }: { database: NotesDatabase; noteId: string }) => {
	// Wrapped, so "not read yet" and "no such note" are not the same answer.
	const found = useLiveQuery(
		// The source being synced is the one showing, and so is this.
		async () => ({ note: await getNote(database, noteId) }),
		[database, noteId]
	);
	const note = found?.note;
	// The paragraph is part of the answer: rendered outside, it would be an
	// empty line under the message while the query is out, and for good after
	// it for a note that is gone.
	if (note === undefined || isTombstone(note) || isVaultPath(note.path)) return null;
	return (
		<p className="muted">
			<Link to="/" {...noteLink(note)}>
				{t('account.openNote')}
			</Link>
		</p>
	);
};

/**
 * Under "this account cannot sync on this server": the operator's own words
 * for why, as the server passed them on with its refusal, and the one thing
 * their gate offers to do about it. Nothing when there is neither — the line
 * above is then the whole of what is known.
 */
const Denied = ({
	status,
	syncable,
	config,
}: {
	status: SchedulerStatus;
	/** Said only where the line above it is (`attentionMessage`). */
	syncable: boolean;
	config: Asked<InstanceConfig>;
}) => {
	if (!syncable || status.phase !== 'attention' || status.refusal !== 'not_entitled') return null;
	const reason = status.denial?.reason;
	const gate = answer(config)?.connectGate;
	if (reason === undefined && gate === undefined) return null;
	return (
		<p className="muted">
			{reason}
			{reason !== undefined && gate !== undefined && ' '}
			{gate !== undefined && (
				// In this window, as the `+` menu's is (`GateLink`).
				<a href={gate.action.url} rel="noreferrer">
					{gate.action.label}
				</a>
			)}
		</p>
	);
};

/** A source the app can sync, and so re-scan: one at a provider it can still connect. */
export const isSyncable = (bound: SyncStateRecord): boolean =>
	bound.provider !== undefined && CONNECTABLE.includes(bound.provider);

/**
 * A source's first import, which holds the app behind its own dialog
 * (`ImportDialog`): the panel offers nothing about syncing until it is done.
 */
export const importingHere = (bound: SyncStateRecord): boolean => bound.importing !== undefined;

interface SyncStateProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	label: string;
	/** This server lets the user connect storage from here. */
	reconnectable: boolean;
	/** What this server offers, which includes what its operator says to an account it will not sync. */
	config: Asked<InstanceConfig>;
	returnTo: string;
	navigate?: (url: string) => void;
	/** Whether the re-scan is being asked about, which the panel holds. */
	rescanning: boolean;
	onRescanning: (asking: boolean) => void;
}

/**
 * What to do about how syncing is going, above the status line
 * (`StatusLine`), which says how it is going itself: here, then, only where it
 * has stopped on something the user has to deal with. Not a live region: it
 * changes on every sync, every minute, and a screen reader announcing each one
 * would be noise; the panel is where the user looks.
 */
export const SyncState = ({
	client,
	database,
	sync,
	bound,
	label,
	reconnectable,
	config,
	returnTo,
	navigate,
	rescanning,
	onRescanning: setRescanning,
}: SyncStateProps) => {
	const status = useSyncStatus(sync);
	const syncable = isSyncable(bound);
	const message = statusMessage(status, label, syncable);
	const reconnect = needsReconnect(status);

	return (
		<>
			{/*
			 * Said even where there is no link to offer: sync has stopped. In
			 * the colour of an error, as the mark on the source's tab is.
			 */}
			{reconnect && (
				<p className="account-problem">
					{status.refusal === 'credential_revoked' ||
					status.refusal === 'credential_required'
						? t('account.reconnect.cannotReach', { provider: label })
						: t('account.reconnect.needed', { provider: label })}
				</p>
			)}
			{/*
			 * A button of the panel's, under what it answers, rather than a word
			 * in the sentence: it was one, dressed as nothing, that a phone's
			 * taller button wrapped onto the line under the text with no space
			 * between them. And what it renders besides — its own error, the
			 * question about the device's notes — is not something a paragraph
			 * may hold.
			 */}
			{reconnect && reconnectable && bound.provider !== undefined && (
				<ConnectButton
					db={database}
					client={client}
					provider={bound.provider}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
				>
					{t('account.reconnect.again')}
				</ConnectButton>
			)}
			{message !== null && status.phase === 'attention' && <p className="muted">{message}</p>}
			<Denied status={status} syncable={syncable} config={config} />
			{/*
			 * Beside the message that names the op, and only there: `stuck`
			 * outlives the run that found it, and an offer to open a note under
			 * "Syncing…" or "Synced" is about a problem the user is not being
			 * told about.
			 */}
			{status.phase === 'attention' && status.stuck?.noteId !== undefined && (
				<StuckNote database={database} noteId={status.stuck.noteId} />
			)}
			{status.conflicts.length > 0 && (
				<p className="muted">{conflictMessage(status.conflicts.length)}</p>
			)}
			<UnreadableNotice files={bound.unreadable} label={label} />
			{/*
			 * The way out of a cursor the provider has lost track of, or a
			 * store that disagrees with the remote about what is there. It is
			 * not a repair of nothing: the confirm says what it costs. Asked for
			 * from the gear's menu, or the `⋯`.
			 */}
			{status.phase !== 'local' && syncable && rescanning && (
				<InlineDialog
					className="account-confirm"
					label={t('account.rescan.confirm')}
					onClose={() => {
						setRescanning(false);
					}}
				>
					<p className="muted">{t('account.rescan.question', { provider: label })}</p>
					<DialogActions
						primary={
							<button
								type="button"
								className="primary"
								disabled={status.phase === 'syncing'}
								onClick={() => {
									setRescanning(false);
									void sync.resync();
								}}
							>
								{t('account.rescan.confirm')}
							</button>
						}
					/>
				</InlineDialog>
			)}
		</>
	);
};
