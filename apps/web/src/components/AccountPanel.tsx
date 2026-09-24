import { parentPath, type ProviderKind } from '@skysa/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
	api,
	type ApiClient,
	type Grant,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { answer, type Asked } from '../api/instanceConfig.js';
import { failedAt, saying } from '../errors/reached.js';
import { folderToSearch } from '../routes/search.js';
import { connectedSources } from '../store/connection.js';
import { credentialFor } from '../store/credentials.js';
import {
	activeConnectionId,
	db as defaultDb,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
	type QueuedOperation,
	type SyncStateRecord,
} from '../store/db.js';
import { holdsTextFor } from '../store/detached.js';
import {
	downloadLibrary,
	downloadNotes,
	downloadProblem,
	downloadSource,
	holdsAnything,
	INCOMPLETE_DOWNLOAD,
	type Library,
} from '../store/exportNotes.js';
import { settleEditors } from '../store/heldEdits.js';
import { type Keeping, keeping as browserKeeping } from '../store/keeping.js';
import { getNote } from '../store/notes.js';
import { type Seen, seenIn, type Unsynced, unsyncedIn } from '../store/unsynced.js';
import {
	type AccountState,
	anyConnected,
	claimConnection,
	CONNECT_FIRST_LABEL,
	CONNECTABLE,
	LEFT_AT_PROVIDER,
	type LetGoInput,
	letGoOfSource,
	type LetGoResult,
	PROVIDER_LABELS,
	type UnsentAnswer,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type StuckOp, type SyncScheduler } from '../sync/scheduler.js';
import { ConnectButton } from './ConnectButton.js';
import { DetachedSource } from './DetachedSource.js';
import { DisconnectDialog } from './DisconnectDialog.js';
import { ImportPanel } from './ImportProgress.js';
import { otherLiveSources } from './MoveUnsent.js';
import { useEscape } from './useEscape.js';

/**
 * Where storage is connected, switched between and let go of: the sources this
 * device holds, the one in front, the devices holding that one, and — for a
 * source being let go — what becomes of the work its remote was never sent
 * (docs/ARCHITECTURE.md §6, "Letting a source go").
 *
 * What the device is bound to is read from the store, so the panel is right
 * offline and the moment a bind lands. What the server says is asked on open —
 * which includes the return from the provider's consent page, since that is a
 * full navigation back into the app — and again whenever another tab binds the
 * device to a connection this panel has not been told about.
 *
 * How syncing is going comes from the scheduler (`sync/scheduler.ts`), which
 * runs on its own; the panel only reports it and offers "Sync now".
 */

type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

type Sync = Pick<SyncScheduler, 'status' | 'subscribe' | 'syncNow' | 'resync' | 'halt'>;

export interface AccountPanelProps {
	client?: Client;
	database?: NotesDatabase;
	sync?: Sync;
	/**
	 * How to leave for the provider's consent page. Injected like the rest, and
	 * for the same reason: jsdom has no navigation, so a test that could not
	 * supply this could only ever prove the button renders.
	 */
	navigate?: (url: string) => void;
	/**
	 * How notes are handed to the user as a file. Injected for the same reason:
	 * jsdom cannot make a blob URL, so the real one cannot run in a test.
	 */
	download?: (notes: readonly NoteRecord[]) => void;
	/** How a whole source is handed to the user as a file, for the same reason. */
	downloadAll?: (library: Library) => void;
	/**
	 * Whether the browser keeps this device's notes. Injected for the same
	 * reason again: jsdom has no `navigator.storage`.
	 */
	keeping?: Keeping;
	/**
	 * Where the way to connect storage is, from here. Beside the tabs it is the
	 * `+` above the panel; in a compact window's source dropdown it is the list
	 * of providers below it, and "above" would send a thumb to nothing.
	 */
	connectIs?: 'above' | 'below';
}

/** Back to exactly here, minus the outcome of any connect before this one. */
export const returnPath = (href: string): string => {
	const url = new URL(href, 'http://app.invalid');
	url.searchParams.delete('connect');
	return url.pathname + url.search;
};

/**
 * Why a disconnect did not happen. `credential_revoked` and `not_found` never
 * arrive here — `disconnectAccount` counts those as the disconnect having
 * already happened — so what is left is a server that declined a live
 * credential, which the user can do nothing about except stop syncing here.
 */
const refusalMessage = (refusal: Refusal): string =>
	refusal === 'not_entitled'
		? 'This account cannot sync on this server, and it would not disconnect it either.'
		: 'The server would not disconnect this account.';

/**
 * What is not known about the outcome, which differs by what was asked of whom.
 *
 * Everything after the disconnect itself is this device's work
 * (`letGoOfSource`), so a failure of the device half can be one that ran before
 * the server was asked or one that ran after it said yes — the account gone at
 * the provider, its refresh token with it, and this device still bound to it.
 * Saying "the account was not disconnected" there was simply false. With
 * nothing asked of the server there is no such doubt, and the doubt is about
 * this device instead.
 *
 * Trying again is safe from either: a second attempt presents a credential the
 * server has already spent, which comes back `credential_revoked` or
 * `not_found`, and `disconnectAccount` counts both as the disconnect having
 * happened.
 */
const mayHave = (onServer: boolean): string =>
	onServer
		? 'The account may already be disconnected; try again.'
		: 'This device may still be syncing the account; try again.';

/**
 * Why a disconnect did not happen, where it failed rather than being refused.
 *
 * Four answers, because there are four different things it can have been and no
 * two are the same thing to do about. A server that answered with a failure is
 * worth trying again; a server that never answered is worth looking at the
 * connection for; a failure that never left the device is neither, since "stop
 * syncing on this device" asks the server nothing at all and a message about a
 * connection would send the user to the one part that was not used. And a
 * failure from neither call cannot say where it happened, so it does not.
 *
 * Which it was comes from `letGoOfSource`, which knows because it made the call
 * (`errors/reached.ts`), rather than from the shape or the words of the error.
 * What it does *not* know is whether the work landed, so no wording here says.
 */
const failureMessage = (error: unknown, onServer: boolean): string =>
	saying(error, {
		answered: 'The server could not disconnect the account. Try again.',
		unreachable: 'The server cannot be reached, so the account is still connected. Try again.',
		device: `Something on this device went wrong. ${mayHave(onServer)}`,
		unknown: `Something went wrong. ${mayHave(onServer)}`,
	});

/** A time today as a time, and any other as a date. */
const when = (at: number): string => {
	const date = new Date(at);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
		: date.toLocaleDateString();
};

/**
 * How syncing is going, in words, or nothing to say. A refusal that connecting
 * again would fix is not said here: the panel offers to connect again instead.
 */
const statusMessage = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): string | null => {
	switch (status.phase) {
		case 'local':
			return null;
		case 'syncing':
			return 'Syncing…';
		case 'idle':
			return status.lastSyncAt === undefined ? 'Synced' : `Synced ${when(status.lastSyncAt)}`;
		case 'offline':
			return 'Offline. Changes are kept on this device and sync when the connection is back.';
		case 'retrying':
			return `Could not sync with ${label}. Trying again shortly (${status.error ?? 'unknown error'}).`;
		case 'attention':
			return attentionMessage(status, label, syncable);
	}
};

const attentionMessage = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): string | null => {
	// Said as what to do, with the link, instead.
	if (needsReconnect(status)) return null;
	if (!syncable) return `This app cannot sync with ${label} yet.`;
	if (status.refusal === 'not_entitled') return 'This account cannot sync on this server.';
	if (status.refusal === 'not_found') return `The server no longer has this ${label} connection.`;
	if (status.stuck !== undefined) return stuckMessage(status.stuck, label);
	return `Some changes could not be sent to ${label}. They will be tried again (${status.error ?? 'unknown error'}).`;
};

/**
 * What a stuck op was trying to do, in the user's terms. `mkdir` and `rmdir`
 * are the two that are not about a note, and so the two with no note to open.
 *
 * `rmdir` cannot actually be stuck — the engine gives up on one rather than
 * holding the queue up (§7, "A dead `rmdir` is given up on") — but it is a
 * queued operation like any other and a label that said nothing would be worse
 * than one that is never read.
 */
const OP_LABELS: Record<QueuedOperation, string> = {
	write: 'the edit to',
	move: 'the rename of',
	delete: 'the deletion of',
	mkdir: 'the new notebook',
	rmdir: 'the removal of the notebook',
};

/**
 * Which op is stuck, by name and path, because "some changes could not be sent"
 * leaves the user with nothing to act on — and the queue is ordered, so this
 * one op is also why everything after it is waiting.
 *
 * A `move`'s target, not its source: the name the user gave it is the one they
 * are looking for.
 */
const stuckMessage = (stuck: StuckOp, label: string): string =>
	`${label} would not take ${OP_LABELS[stuck.op]} ${stuck.targetPath ?? stuck.path} after ${String(stuck.attempts)} tries (${stuck.error ?? 'unknown error'}). Everything queued behind it is waiting. “Sync now” tries again.`;

/** A problem that connecting the account again is the answer to. */
const needsReconnect = (status: SchedulerStatus): boolean =>
	status.phase === 'attention' &&
	(status.refusal === 'credential_required' ||
		status.refusal === 'credential_revoked' ||
		status.refusal === 'reauthorize_required' ||
		(status.refusal === undefined && status.error === 'authorization required'));

const conflictMessage = (count: number): string =>
	count === 1
		? 'A note was edited here and elsewhere at once. Both versions are kept; the copy has "conflict" in its name.'
		: `${String(count)} notes were edited here and elsewhere at once. Both versions of each are kept; the copies have "conflict" in their names.`;

/** How many of the files that could not be read are named before "and N more". */
const UNREADABLE_NAMED = 5;

const byName = (one: string, two: string): number => one.localeCompare(two);

/**
 * `a.md, b.md, … and 3 more`. Each path is its own `<bdi>`, so a name written
 * right-to-left cannot reorder the list around it or swallow the comma after
 * it — the path is data, and the sentence is not.
 */
const PathList = ({ paths }: { paths: readonly string[] }) => {
	const named = paths.slice(0, UNREADABLE_NAMED);
	const more = paths.length - named.length;
	return (
		<>
			{named.map((path, at) => (
				<Fragment key={path}>
					{at > 0 && ', '}
					<bdi>{path}</bdi>
				</Fragment>
			))}
			{more > 0 && `, … and ${String(more)} more`}
		</>
	);
};

/**
 * The files in this source that are not UTF-8 text, which sync leaves alone
 * (docs/ARCHITECTURE.md §7). Said because nothing else does: such a file is not in the
 * list of notes, and a note whose file became one has gone from this device.
 * By path, since that is how the user finds the file in the tool that wrote it,
 * and with what to do about it, since nothing here can do it for them.
 *
 * And where a note of theirs went when one of these files took its name
 * (`movedAside`). That is not a conflict — nothing was edited twice and no copy
 * was made — so it is said here, beside the file that caused it, rather than in
 * the conflicts line above.
 */
const UnreadableNotice = ({
	files = [],
	label,
}: {
	files: SyncStateRecord['unreadable'];
	label: string;
}) => {
	const paths = files.map((file) => file.path).sort(byName);
	const moved = [...new Set(files.flatMap((file) => file.movedAside ?? []))].sort(byName);
	const [only] = paths;
	if (only === undefined) return null;
	return (
		<p className="muted wrap-anywhere">
			{paths.length === 1 ? (
				<>
					<bdi>{only}</bdi>
					{` in ${label} is not UTF-8 text, so it is left alone: not shown here, not changed. Save it as UTF-8, or delete it, and it will be read.`}
				</>
			) : (
				<>
					{`${String(paths.length)} files in ${label} are not UTF-8 text, so they are left alone: `}
					<PathList paths={paths} />
					{`. Save them as UTF-8, or delete them, and they will be read.`}
				</>
			)}
			{moved.length > 0 && (
				<>
					{moved.length === 1
						? ' A note of yours had that name; it is now at '
						: ' Notes of yours had those names; they are now at '}
					<PathList paths={moved} />
					{'.'}
				</>
			)}
		</p>
	);
};

/**
 * Where to withdraw the app's access by hand, for a provider that gives the
 * server no way to. The links open elsewhere, so the confirmation — and the
 * address — are still here to come back to.
 */
const LeftAtProvider = ({ provider }: { provider: ProviderKind | undefined }) => {
	const left = provider === undefined ? undefined : LEFT_AT_PROVIDER[provider];
	if (left === undefined) return null;
	return (
		<p className="muted">
			{left.summary}{' '}
			{left.places.map((place, index) => (
				<Fragment key={place.href}>
					{index > 0 && '; '}
					<a href={place.href} target="_blank" rel="noreferrer">
						{place.label}
					</a>{' '}
					for {place.accounts}
				</Fragment>
			))}
			.
		</p>
	);
};

interface LocalProps {
	client: Client;
	database: NotesDatabase;
	config: Asked<InstanceConfig>;
	returnTo: string;
	navigate?: (url: string) => void;
	connectIs?: 'above' | 'below';
}

/**
 * Where to go to connect, named as the control there is named. With nothing
 * connected yet the `+` carries its words (`CONNECT_FIRST_LABEL`), and the
 * compact panel's list is headed by them.
 */
const connectHint = (connectIs: 'above' | 'below', first: boolean): string =>
	first
		? ` Use “${CONNECT_FIRST_LABEL}” ${connectIs} to sync them.`
		: { above: ' Use + above to connect storage.', below: ' Connect storage below.' }[
				connectIs
			];

/**
 * The whole of one source, as one archive of markdown files: the tree a push
 * would make in its folder (docs/ARCHITECTURE.md §14). Offered once there is
 * something to put in it, and not before, when all it could make is an empty
 * archive.
 *
 * What went wrong is said here, where it was asked for: a download that fails
 * without a word is one the user goes on waiting for. So is an archive handed
 * over without the text an editor could not save (`downloadSource`).
 */
const DownloadAll = ({
	database,
	connectionId,
	holds,
	downloadAll,
}: {
	database: NotesDatabase;
	connectionId: string;
	/** `holdsAnything`, as the panel has read it: undefined until it has. */
	holds: boolean | undefined;
	downloadAll: (library: Library) => void;
}) => {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	if (holds !== true) return null;
	return (
		<>
			<button
				type="button"
				disabled={busy}
				onClick={() => {
					setBusy(true);
					setProblem(null);
					void downloadSource(database, connectionId, downloadAll)
						.then(({ incomplete }) => {
							if (incomplete) setProblem(INCOMPLETE_DOWNLOAD);
						})
						.catch((error: unknown) => {
							setProblem(downloadProblem(error));
						})
						.finally(() => {
							setBusy(false);
						});
				}}
			>
				Download all notes
			</button>
			{problem !== null && (
				<p className="muted" role="alert">
					{problem}
				</p>
			)}
		</>
	);
};

/**
 * What the browser has said about keeping this device's notes, asked on sight
 * — `persisted()` never prompts — and followed as it changes, since the request
 * that changes it is made from somewhere else (a note being created).
 *
 * Asked again whenever the tab comes back into view: the answer can change
 * where this tab cannot hear it, in another tab's request or in the browser's
 * own site settings.
 */
const useKept = (keep: Keeping) => {
	const kept = useSyncExternalStore(keep.subscribe, keep.state);
	useEffect(() => {
		void keep.check();
		const shown = () => {
			if (document.visibilityState === 'visible') void keep.check();
		};
		document.addEventListener('visibilitychange', shown);
		return () => {
			document.removeEventListener('visibilitychange', shown);
		};
	}, [keep]);
	return kept;
};

const NotConnected = ({
	config,
	database,
	connectIs = 'above',
	downloadAll,
	keep,
}: LocalProps & { downloadAll: (library: Library) => void; keep: Keeping }) => {
	const settings = answer(config);
	const holds = useLiveQuery(() => holdsAnything(database, LOCAL_CONNECTION_ID), [database]);
	const kept = useKept(keep);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];
	const sources = useLiveQuery(() => connectedSources(database), [database]);

	return (
		<section className="account" aria-label="Storage">
			<p className="muted">
				Notes are kept on this device only.
				{offerable.length > 0 &&
					sources !== undefined &&
					connectHint(connectIs, !anyConnected(sources))}
			</p>
			{settings?.authMode === 'account-first' && (
				<p className="muted">
					Connecting storage needs a sign-in this server does not offer yet.
				</p>
			)}
			{config.kind === 'unreachable' && (
				<p className="muted">
					Connecting storage needs the server, which cannot be reached.
				</p>
			)}
			{/*
			 * The one place the notes here are all there is, so the one place it
			 * is said. Not before the browser has answered, and not once it has
			 * said it will keep them. What helps is connecting, which makes a
			 * second copy, and the button below, which makes one now.
			 *
			 * Not installing, though the app asks again when it is installed.
			 * It is advice that holds only in Chromium: Firefox on a desktop has
			 * nothing to install, and in Safari a Home Screen app keeps its data
			 * apart from Safari's, so the installed app opens empty and the
			 * notes stay where they were (docs/ARCHITECTURE.md §8).
			 */}
			{holds === true && kept === 'not-kept' && (
				<p className="muted">
					This browser may clear them without warning. To keep them, connect storage or
					download them.
				</p>
			)}
			<DownloadAll
				database={database}
				connectionId={LOCAL_CONNECTION_ID}
				holds={holds}
				downloadAll={downloadAll}
			/>
		</section>
	);
};

/**
 * The note a stuck op is about, when it is still here. A stuck `delete` is
 * about a note the user has already deleted — its row is a tombstone — and
 * offering to open that would be offering nothing.
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
	if (note === undefined || note.deletedLocally === 1) return null;
	return (
		<p className="muted">
			<Link to="/" search={{ folder: folderToSearch(parentPath(note.path)), note: note.id }}>
				Open the note
			</Link>
		</p>
	);
};

interface SyncStateProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	label: string;
	/** This server lets the user connect storage from here. */
	reconnectable: boolean;
	returnTo: string;
	navigate?: (url: string) => void;
}

/**
 * How syncing is going, and what to do about it. Not a live region: it changes
 * on every sync, every minute, and a screen reader announcing each one would
 * be noise; the panel is where the user looks.
 */
const SyncState = ({
	client,
	database,
	sync,
	bound,
	label,
	reconnectable,
	returnTo,
	navigate,
}: SyncStateProps) => {
	const status = useSyncStatus(sync);
	const syncable = bound.provider !== undefined && CONNECTABLE.includes(bound.provider);
	const message = statusMessage(status, label, syncable);
	const reconnect = needsReconnect(status);
	const [rescanning, setRescanning] = useState(false);

	// A later source's first import, which does not hold the app: how it is
	// going, and the way out of it, in place of how syncing is going. The
	// first source's is a dialog over everything (`routes/index.tsx`).
	if (bound.importing !== undefined && !bound.importing.lock) {
		return <ImportPanel source={bound} database={database} client={client} sync={sync} />;
	}

	return (
		<>
			{/* Said even where there is no link to offer: sync has stopped. */}
			{reconnect && (
				<p className="muted">
					{status.refusal === 'credential_revoked' ||
					status.refusal === 'credential_required'
						? `This device can no longer reach ${label}.`
						: `${label} needs to be connected again.`}
					{reconnectable && bound.provider !== undefined && (
						<>
							{' '}
							<ConnectButton
								db={database}
								client={client}
								provider={bound.provider}
								returnTo={returnTo}
								className="link"
								{...(navigate === undefined ? {} : { navigate })}
							>
								Connect again
							</ConnectButton>
						</>
					)}
				</p>
			)}
			{message !== null && <p className="muted">{message}</p>}
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
			{status.phase !== 'local' && (
				<button
					type="button"
					disabled={status.phase === 'syncing'}
					onClick={() => {
						void sync.syncNow();
					}}
				>
					Sync now
				</button>
			)}
			{/*
			 * The way out of a cursor the provider has lost track of, or a
			 * store that disagrees with the remote about what is there. It is
			 * not a repair of nothing: the confirm says what it costs.
			 */}
			{status.phase !== 'local' &&
				syncable &&
				(rescanning ? (
					<div className="account-confirm">
						<p className="muted">
							Read everything in {label} again? This device compares every note with
							the folder from scratch. Notes that are no longer in {label} are removed
							here too, unless they have edits that have not been sent.
						</p>
						<button
							type="button"
							disabled={status.phase === 'syncing'}
							onClick={() => {
								setRescanning(false);
								void sync.resync();
							}}
						>
							Re-scan
						</button>
						<button
							type="button"
							className="ghost"
							onClick={() => {
								setRescanning(false);
							}}
						>
							Cancel
						</button>
					</div>
				) : (
					<button
						type="button"
						disabled={status.phase === 'syncing'}
						onClick={() => {
							setRescanning(true);
						}}
					>
						Re-scan from scratch
					</button>
				))}
		</>
	);
};

/**
 * The devices holding this connection, and the way to take one away.
 *
 * The point of it is that a stolen credential is visible and revocable. It is
 * the compensating control for holding a bearer in IndexedDB, where `httpOnly`
 * cannot protect it (docs/ARCHITECTURE.md §6), so it is asked for on open rather than
 * hidden behind a disclosure the user would never press.
 *
 * Revoking is permanent in a way worth saying: the server spends a credential's
 * hash for ever, so the device that held it cannot be talked back into this
 * connection — it has to be connected again from scratch.
 */
const Devices = ({
	client,
	database,
	connectionId,
}: {
	client: Client;
	database: NotesDatabase;
	/**
	 * Which source these are the devices of. Named rather than looked up, for
	 * two reasons: it is what makes the effect re-run on a switch — without it
	 * the list stays on the previous source's devices while the panel above
	 * names the new one, and pressing Remove sends a grant id the new
	 * connection has never heard of — and it pins every call in this component
	 * to one source, rather than re-reading "whichever is in front" between
	 * asking and revoking.
	 */
	connectionId: string;
}) => {
	const [grants, setGrants] = useState<Asked<Grant[]>>({ kind: 'asking' });
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	// Only the newest question's answer is kept, and none once the source has
	// changed or the panel has gone. A slow answer about one source landing under
	// another's name is a list of grant ids the source on screen has never heard
	// of, each with a Remove button.
	const question = useRef(0);
	const ask = useCallback(() => {
		question.current += 1;
		const mine = question.current;
		const settle = (next: Asked<Grant[]>) => {
			if (question.current === mine) setGrants(next);
		};
		void withHeld(database, client, connectionId)
			.then((authed) => (authed === undefined ? undefined : authed.grants()))
			.then((result) => {
				settle(
					result === undefined || !result.ok
						? { kind: 'unreachable' }
						: { kind: 'answered', value: result.value }
				);
			})
			.catch(() => {
				settle({ kind: 'unreachable' });
			});
	}, [client, database, connectionId]);
	useEffect(() => {
		ask();
		return () => {
			question.current += 1;
		};
	}, [ask]);

	const listed = answer(grants);
	if (listed === undefined || listed.length < 2) return null;

	const revoke = (grantId: string) => {
		setBusy(grantId);
		setProblem(null);
		// Each half labelled as it is called: the credential is read from this
		// device and the grant is revoked on the server, and a failure of the
		// first has nothing to do with a connection. The device half runs strictly
		// before the server is asked, which is what lets its wording say that
		// nothing was removed.
		void failedAt('device', () => withHeld(database, client, connectionId))
			.then((authed) =>
				authed === undefined
					? undefined
					: failedAt('server', () => authed.revokeGrant(grantId))
			)
			.then((result) => {
				if (result?.ok === true) {
					ask();
					return;
				}
				setProblem('That device is still signed in: the server would not remove it.');
			})
			.catch((error: unknown) => {
				setProblem(
					saying(error, {
						answered: 'The server could not remove that device. Try again.',
						unreachable:
							'The server cannot be reached, so nothing was removed. Try again.',
						device: 'Something on this device went wrong, so nothing was removed. Try again.',
						// Neither call, so it happened after the revoke had already
						// done whatever it did.
						unknown:
							'Something went wrong. That device may already have been removed; try again.',
					})
				);
			})
			.finally(() => {
				setBusy(null);
			});
	};

	return (
		<div className="account-devices">
			<p className="muted">Devices signed in to this account:</p>
			<ul aria-label="Devices">
				{listed.map((grant) => (
					<li key={grant.id}>
						<span className="muted">
							{grant.current
								? 'This device'
								: `A device, last used ${when(grant.lastUsedAt)}`}
							{grant.expired && ' · signed out for being idle'}
						</span>
						{!grant.current && (
							<button
								type="button"
								className="link"
								disabled={busy !== null}
								onClick={() => {
									revoke(grant.id);
								}}
							>
								Remove
							</button>
						)}
					</li>
				))}
			</ul>
			{problem !== null && (
				<p className="muted" role="alert">
					{problem}
				</p>
			)}
		</div>
	);
};

/** The client, presenting the credential this device holds for one source. */
const withHeld = async (
	database: NotesDatabase,
	client: Client,
	connectionId: string
): Promise<ApiClient | undefined> => {
	const held = await credentialFor(database, connectionId);
	return held === undefined ? undefined : client.withCredential(held.credential);
};

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
const prepare = async (
	database: NotesDatabase,
	connectionId: string,
	push: (() => Promise<void>) | undefined
): Promise<{ listed: Unsynced; seen: Seen; failing: boolean }> => {
	const settled = await settleEditors();
	if (push !== undefined) {
		await Promise.race([push().catch(() => undefined), after(LAST_PUSH_MS)]);
	}
	const listed = await unsyncedIn(database, connectionId);
	const standing = (
		await database.folders.where('connectionId').equals(connectionId).toArray()
	).map((folder) => folder.path);
	return { listed, seen: seenIn(listed, standing), failing: holdsTextFor(settled, connectionId) };
};

/**
 * What the account is called: as the server has just said it, or else as it
 * last did — the panel has to be able to name the account offline too.
 */
const accountName = (state: AccountState | undefined, bound: SyncStateRecord): string | null => {
	const said =
		state?.kind === 'connected' && state.connection.id === bound.connectionId
			? state.connection.displayName
			: null;
	return said ?? bound.displayName ?? null;
};

interface ConnectedProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	config: Asked<InstanceConfig>;
	account: Asked<AccountState>;
	/** Every disconnect that has been asked for, by source: see `useDisconnects`. */
	disconnects: Readonly<Record<string, Disconnecting>>;
	onDisconnect: (connectionId: string, answer: Omit<LetGoInput, 'connectionId'>) => Promise<void>;
	/** Hand the notes that were never sent to the user as a file. */
	download: (notes: readonly NoteRecord[]) => void;
	/** Hand the whole source to the user as a file. */
	downloadAll: (library: Library) => void;
	returnTo: string;
	navigate?: (url: string) => void;
}

/** A disconnect that is under way, or that the server would not or could not do. */
interface Disconnecting {
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
			return said(
				'Something was written in this source after the list was shown. It was not on the list, so it has been kept.'
			);
		case 'holding':
			return said(
				'A note here has text that could not be saved, so the note and this source have been kept rather than removed with it. Open the note and copy the text somewhere safe; the note says how.'
			);
		case 'reconnected':
			return said('This source was connected again meanwhile. Nothing has been changed.');
		case 'no-target':
			return said('That source is not connected any more, so nothing was moved.');
		case 'unverified':
			return said(
				'This source has not been checked against its account yet, so what it holds could not be told apart from work that was never sent. Nothing was moved.'
			);
		case 'nothing-to-move':
			return said('There was nothing here to move, so nothing was moved.');
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
const useDisconnects = (database: NotesDatabase, client: Client) => {
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

/**
 * Whether one last push before the question is worth waiting for. Not where the
 * scheduler is not syncing this source anyway, not where it has already stopped
 * on something it will stop on again, and not where there is no network: each
 * of those is a delay in front of the same question.
 */
const worthPushing = (status: SchedulerStatus): boolean =>
	navigator.onLine &&
	status.phase !== 'local' &&
	status.phase !== 'attention' &&
	status.phase !== 'offline';

/**
 * Why the last push could not clear what is here, where the user would do
 * better to cancel and come back to it. Not a reason to refuse the disconnect:
 * they may have no intention of ever reaching this account again.
 */
const stoppedBy = (status: SchedulerStatus, listed: Unsynced): 'offline' | 'blocked' | null => {
	if (status.phase === 'offline' || !navigator.onLine) return 'offline';
	return listed.blocked ? 'blocked' : null;
};

/**
 * Where the disconnect has got to. Closed; sending what is left, which can take
 * as long as a provider takes; or asking, holding the list the question is
 * about and the record of it the answer will be held to.
 *
 * `onServer` rides along from the button that started it: the same question is
 * asked for a plain Disconnect and for "stop syncing on this device", and the
 * only difference is whether the server is told.
 */
type Step =
	| { kind: 'closed' }
	| { kind: 'pushing'; onServer: boolean }
	| ({ kind: 'asking'; onServer: boolean } & Awaited<ReturnType<typeof prepare>>);

const Connected = ({
	client,
	database,
	sync,
	bound,
	config,
	account,
	disconnects,
	onDisconnect,
	download,
	downloadAll,
	returnTo,
	navigate,
}: ConnectedProps) => {
	const [step, setStep] = useState<Step>({ kind: 'closed' });
	const [trouble, setTrouble] = useState<string | null>(null);
	const status = useSyncStatus(sync);
	// Only ever this source's. Named once per render, so the click below is
	// about the source the user was looking at when they pressed it.
	const connectionId = bound.connectionId;
	const holds = useLiveQuery(
		() => holdsAnything(database, connectionId),
		[database, connectionId]
	);
	// The other live sources, which what this one never sent could go to.
	const sources = useLiveQuery(() => connectedSources(database), [database]);
	const targets = otherLiveSources(sources, connectionId);
	const disconnecting = disconnects[connectionId];
	const busy = disconnecting?.busy === true;
	const problem = disconnecting?.problem ?? null;
	const stranded = disconnecting?.stranded === true;
	// Focus follows the step the user is on, rather than falling to the page
	// when the button they pressed goes away. Not on first render.
	const focusNext = useRef<'cancel' | 'open' | null>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const openButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	// Which question the answer coming back belongs to (`ask`).
	const asking = useRef(0);
	const open = step.kind !== 'closed';
	useEffect(() => {
		const target = focusNext.current === 'cancel' ? cancelButton : openButton;
		// Only focus that is still here to move. A disconnect can take seconds
		// to answer, and a user who went back to a note meanwhile keeps typing
		// into the note, not into a button.
		const focused = document.activeElement;
		const here =
			focused === null ||
			focused === document.body ||
			panel.current?.contains(focused) === true;
		if (focusNext.current !== null && here) target.current?.focus();
		focusNext.current = null;
	}, [step.kind]);
	const cancel = useCallback(() => {
		// A question nobody is waiting for the answer to: whatever the last push
		// is doing, it can go on doing.
		asking.current += 1;
		focusNext.current = 'open';
		setStep({ kind: 'closed' });
	}, []);
	useEscape(panel, open, cancel);

	const label = bound.provider === undefined ? 'storage' : PROVIDER_LABELS[bound.provider];
	const displayName = accountName(answer(account), bound);

	const pushable = worthPushing(status);

	/**
	 * Ask the question. Only the newest one's answer is taken up: a user who
	 * cancels while the last push is out, and presses Disconnect again, must not
	 * have the first list arrive on top of the second.
	 */
	const ask = (onServer: boolean) => {
		asking.current += 1;
		const mine = asking.current;
		focusNext.current = 'cancel';
		setTrouble(null);
		setStep({ kind: 'pushing', onServer });
		void prepare(database, connectionId, pushable ? () => sync.syncNow() : undefined)
			.then((ready) => {
				if (asking.current !== mine) return;
				// Again: the Cancel the focus was on belonged to the step that is
				// about to go, and the question is the one that has to be answered
				// safely by a stray Enter.
				focusNext.current = 'cancel';
				setStep({ kind: 'asking', onServer, ...ready });
			})
			.catch(() => {
				if (asking.current !== mine) return;
				setStep({ kind: 'closed' });
				setTrouble(
					'What is on this device could not be read, so nothing was disconnected.'
				);
			});
	};

	const answered = (choice: UnsentAnswer) => {
		if (step.kind !== 'asking') return;
		const { seen, onServer } = step;
		// Closing the question is this instance's to do, and nothing if it has
		// gone; what came of the disconnect is the panel's, and is kept.
		void onDisconnect(connectionId, { unsent: choice, seen, onServer }).finally(() => {
			cancel();
		});
	};

	return (
		<section ref={panel} className="account" aria-label="Storage">
			<p>
				Syncing with {label}
				{displayName !== null && <span className="muted"> · {displayName}</span>}
			</p>
			<SyncState
				client={client}
				database={database}
				sync={sync}
				bound={bound}
				label={label}
				reconnectable={answer(config)?.authMode === 'storage-first'}
				returnTo={returnTo}
				{...(navigate === undefined ? {} : { navigate })}
			/>
			{/*
			 * Not while an import is filling the source, when the archive would be
			 * whatever part of it had arrived; nor while the disconnect question
			 * is open, which offers its own download of what was never sent.
			 */}
			{bound.importing === undefined && !open && (
				<DownloadAll
					database={database}
					connectionId={connectionId}
					holds={holds}
					downloadAll={downloadAll}
				/>
			)}
			<Devices client={client} database={database} connectionId={bound.connectionId} />
			{(problem ?? trouble) !== null && (
				<p className="muted" role="alert">
					{problem ?? trouble}
				</p>
			)}
			{stranded && !open && (
				<button
					type="button"
					className="ghost"
					onClick={() => {
						// The same question again, and nothing asked of the server:
						// it has already refused, and nothing on it is touched.
						ask(false);
					}}
				>
					Stop syncing on this device
				</button>
			)}
			{step.kind === 'pushing' && (
				<div
					className="account-confirm"
					role="group"
					aria-label="Sending your last changes"
				>
					<p className="muted">Sending your last changes…</p>
					<button ref={cancelButton} type="button" className="ghost" onClick={cancel}>
						Cancel
					</button>
				</div>
			)}
			{step.kind === 'asking' && (
				<DisconnectDialog
					label={label}
					displayName={displayName}
					listed={step.listed}
					targets={targets}
					failing={step.failing}
					busy={busy}
					leftAtProvider={<LeftAtProvider provider={bound.provider} />}
					stopped={stoppedBy(status, step.listed)}
					download={download}
					onAnswer={answered}
					onCancel={cancel}
					cancelRef={cancelButton}
				/>
			)}
			{!open && (
				<button
					ref={openButton}
					type="button"
					className="danger"
					// Not while the server is still being asked on open: its
					// answer could bind the device again right after. Nor while a
					// disconnect of this source is still out, which may have been
					// started before the user looked at another source and back.
					disabled={account.kind === 'asking' || busy}
					onClick={() => {
						ask(true);
					}}
				>
					Disconnect…
				</button>
			)}
		</section>
	);
};

interface DetachedProps extends LocalProps {
	bound: SyncStateRecord;
	download: (notes: readonly NoteRecord[]) => void;
	onReleased: () => void;
	/**
	 * What came of the disconnect that left it detached, where that is not what
	 * was asked for — the panel underneath the answer changes as the answer
	 * lands, so the source's own panel is where it has to be said.
	 */
	notice: string | null;
}

/**
 * The panel of a detached source (`DetachedSource`), given the two things only
 * this module can make for it: the way to connect its account again, and the
 * list of the other sources.
 *
 * Reconnecting is the ordinary connect flow, for the provider this source was
 * at, and offered only where the server offers that. Whether what comes back is
 * this source's account is decided when it is bound (`bindConnection`): the
 * same one takes these rows up, and any other is simply another source, with
 * these left exactly where they are.
 */
const Detached = ({
	client,
	database,
	config,
	bound,
	download,
	onReleased,
	notice,
	returnTo,
	navigate,
}: DetachedProps) => {
	const settings = answer(config);
	const provider = bound.provider;
	const reconnectable =
		provider !== undefined &&
		CONNECTABLE.includes(provider) &&
		settings?.authMode === 'storage-first' &&
		settings.providers.includes(provider);
	return (
		<DetachedSource
			database={database}
			bound={bound}
			download={download}
			onReleased={onReleased}
			notice={notice}
			reconnect={
				reconnectable && (
					<ConnectButton
						db={database}
						client={client}
						provider={provider}
						returnTo={returnTo}
						{...(navigate === undefined ? {} : { navigate })}
					>
						Reconnect
					</ConnectButton>
				)
			}
		/>
	);
};

export const AccountPanel = ({
	client = api,
	database = defaultDb,
	sync = syncScheduler,
	navigate,
	download = downloadNotes,
	downloadAll = downloadLibrary,
	keeping = browserKeeping,
	connectIs = 'above',
}: AccountPanelProps) => {
	const href = useRouterState({ select: (state) => state.location.href });
	// Wrapped: `first()` answers `undefined` for "no connection", and so does
	// `useLiveQuery` for "not read yet". Unwrapped, the two look the same.
	// The source the app is showing, not whichever `syncState` row IndexedDB
	// hands back first. A device may hold several connected sources at once
	// (docs/ARCHITECTURE.md §6) and the first row is then a coin toss: the panel would
	// name one account while the notes on screen belong to another, and
	// switching sources would change nothing here. The live query reads `prefs`
	// as well as `syncState`, so a switch in another tab re-renders this one.
	const bound = useLiveQuery(
		async () => ({ state: await database.syncState.get(await activeConnectionId(database)) }),
		[database]
	);
	const [config, setConfig] = useState<Asked<InstanceConfig>>({ kind: 'asking' });
	const [account, setAccount] = useState<Asked<AccountState>>({ kind: 'asking' });
	const { disconnects, disconnect } = useDisconnects(database, client);

	// A discard takes its source, and its panel, with it: the button the user
	// pressed is gone and the focus would fall to the page. It goes to the next
	// panel instead, once that has rendered — to whatever that panel offers
	// first, and failing that to the panel itself.
	//
	// "Failing that" is the ordinary case now that the source list and the
	// connect buttons have moved to the tab bar: discard the last source and
	// what is left here is a sentence. The frame takes `tabIndex={-1}` so there
	// is somewhere to land that says where the user is, rather than the body,
	// which says nothing and puts the next Tab back at the top of the page.
	// Not the bar's `+`: the panel does not own it, and a component reaching
	// across the screen for someone else's button is how focus ends up fought
	// over by two of them.
	const frame = useRef<HTMLDivElement>(null);
	const landing = useRef(false);
	const showing = bound?.state?.connectionId ?? null;
	useEffect(() => {
		if (!landing.current) return;
		landing.current = false;
		const next = frame.current?.querySelector<HTMLElement>('button') ?? frame.current;
		next?.focus();
	}, [showing]);
	const released = () => {
		landing.current = true;
	};

	useEffect(() => {
		void client
			.config()
			.then((value) => {
				setConfig({ kind: 'answered', value });
			})
			.catch(() => {
				setConfig({ kind: 'unreachable' });
			});
	}, [client]);

	// What the server is asked about: on open, and again whenever the binding
	// has moved to a connection the answer in hand does not name — another tab
	// connecting an account binds this device too. Never because of an answer
	// alone, so a server that cannot be reached is not asked in a loop, and
	// never while a question is out: a change that lands meanwhile is weighed
	// once the answer is in, against the binding the question was about.
	const boundId = bound === undefined ? null : (bound.state?.connectionId ?? '');
	const answered = answer(account);
	const named = answered?.kind === 'connected' ? answered.connection.id : undefined;
	const asking = useRef(false);
	const askedAbout = useRef<string | null>(null);
	useEffect(() => {
		if (boundId === null || asking.current) return;
		const before = askedAbout.current;
		if (before === boundId) return;
		askedAbout.current = boundId;
		// Gone, or bound by the panel's own answer: nothing to ask.
		if (before !== null && (boundId === '' || named === boundId)) return;
		asking.current = true;
		const settle = (next: Asked<AccountState>) => {
			// Before the state changes, so the render it causes can ask again.
			asking.current = false;
			setAccount(next);
		};
		// `claimConnection`, not `reconcileAccount`: this effect also runs on the
		// return from the consent page, which is a full navigation back into the
		// app, and that is where a pending credential has to be taken up. With no
		// pending credential it reconciles, so there is no URL to read and a
		// reload in the middle of a flow lands in the same place.
		void claimConnection(database, client)
			.then((value) => {
				settle({ kind: 'answered', value });
			})
			.catch(() => {
				settle({ kind: 'unreachable' });
			});
	}, [boundId, named, account, client, database]);

	if (bound === undefined) return null;
	const returnTo = returnPath(href);

	const panel = () => {
		if (bound.state === undefined) {
			return (
				<NotConnected
					client={client}
					database={database}
					config={config}
					returnTo={returnTo}
					connectIs={connectIs}
					downloadAll={downloadAll}
					keep={keeping}
					{...(navigate === undefined ? {} : { navigate })}
				/>
			);
		}

		if (bound.state.detached !== undefined) {
			return (
				<Detached
					key={bound.state.connectionId}
					client={client}
					database={database}
					config={config}
					bound={bound.state}
					download={download}
					onReleased={released}
					notice={disconnects[bound.state.connectionId]?.problem ?? null}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
				/>
			);
		}

		return (
			// Keyed by source. Everything under here holds state about one source — a
			// confirm half way through, a re-scan being asked about, a list of devices
			// — and unkeyed it survives "Show other source" and is rendered, and acted
			// on, under the other one's name. What has to outlive the switch is handed
			// down instead, by the source it names.
			<Connected
				key={bound.state.connectionId}
				disconnects={disconnects}
				onDisconnect={disconnect}
				download={download}
				downloadAll={downloadAll}
				client={client}
				database={database}
				sync={sync}
				bound={bound.state}
				config={config}
				account={account}
				returnTo={returnTo}
				{...(navigate === undefined ? {} : { navigate })}
			/>
		);
	};
	// `tabIndex={-1}`: reachable by script, so a discard has somewhere to put
	// the focus, and never in the tab order, where an empty wrapper would be a
	// stop that does nothing.
	return (
		<div ref={frame} tabIndex={-1}>
			{panel()}
		</div>
	);
};
