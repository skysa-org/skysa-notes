import { parentPath, type ProviderKind } from '@skysa/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import {
	api,
	type ApiClient,
	ApiError,
	type Grant,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { folderToSearch } from '../routes/search.js';
import { type ConnectedSource, connectedSources, showConnection } from '../store/connection.js';
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
import { downloadNotes } from '../store/exportNotes.js';
import { settleEditors } from '../store/heldEdits.js';
import { getNote } from '../store/notes.js';
import { countOf, unsyncedIn } from '../store/unsynced.js';
import {
	type AccountState,
	claimConnection,
	CONNECTABLE,
	disconnectAccount,
	LEFT_AT_PROVIDER,
	PROVIDER_LABELS,
	sourceName,
	stopSyncingHere,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type StuckOp, type SyncScheduler } from '../sync/scheduler.js';
import { ConnectButton } from './ConnectButton.js';
import { DetachedSource } from './DetachedSource.js';
import { useEscape } from './useEscape.js';

/**
 * Where the storage account is connected and disconnected: one account, replace
 * or disconnect only (docs/PLAN.md, Phase 2).
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

type Sync = Pick<SyncScheduler, 'status' | 'subscribe' | 'syncNow' | 'resync'>;

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
}

/** A server answer: still being asked, not reachable, or what it said. */
type Asked<T> = { kind: 'asking' } | { kind: 'unreachable' } | { kind: 'answered'; value: T };

const answer = <T,>(asked: Asked<T>): T | undefined =>
	asked.kind === 'answered' ? asked.value : undefined;

/** Back to exactly here, minus the outcome of any connect before this one. */
const returnPath = (href: string): string => {
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

const failureMessage = (error: unknown): string =>
	error instanceof ApiError
		? 'The server could not disconnect the account. Try again.'
		: 'The server cannot be reached, so the account is still connected.';

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
 * (docs/PLAN.md §7). Said because nothing else does: such a file is not in the
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
}

const NotConnected = ({ client, database, config, returnTo, navigate }: LocalProps) => {
	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];

	return (
		<section className="account" aria-label="Storage">
			<p className="muted">Notes are kept on this device only.</p>
			{offerable.map((provider) => (
				<ConnectButton
					key={provider}
					db={database}
					client={client}
					provider={provider}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
				>
					Connect {PROVIDER_LABELS[provider]}
				</ConnectButton>
			))}
			<Sources
				client={client}
				database={database}
				config={config}
				returnTo={returnTo}
				another={false}
				{...(navigate === undefined ? {} : { navigate })}
			/>
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
						className="ghost"
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
 * The sources this device holds, and which one the app is showing.
 *
 * Shown only once there are two: with one connected source a list of one is
 * noise, and the panel already names it. Switching moves nothing — each source
 * keeps its own notes, notebooks, queue and cursor (docs/PLAN.md §6) — so this
 * is a change of view, and the wording says so rather than implying a transfer.
 */
const Sources = ({
	client,
	database,
	config,
	returnTo,
	navigate,
	another = true,
}: LocalProps & {
	config: Asked<InstanceConfig>;
	/** Whether to offer connecting another account: not where the panel already offers the first. */
	another?: boolean;
}) => {
	const sources = useLiveQuery(() => connectedSources(database), [database]);
	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];
	if (sources === undefined) return null;

	return (
		<div className="account-sources">
			{sources.length > 1 && (
				<ul aria-label="Connected sources">
					{sources.map((source: ConnectedSource) => (
						<li key={source.connectionId}>
							{source.active ? (
								<span className="muted">{sourceLabel(source)} · showing</span>
							) : (
								<button
									type="button"
									className="link"
									onClick={() => {
										void showConnection(database, source.connectionId);
									}}
								>
									Show {sourceLabel(source)}
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			{another &&
				offerable.map((provider) => (
					<ConnectButton
						key={provider}
						db={database}
						client={client}
						provider={provider}
						returnTo={returnTo}
						className="link"
						{...(navigate === undefined ? {} : { navigate })}
					>
						Connect another {PROVIDER_LABELS[provider]} account
					</ConnectButton>
				))}
		</div>
	);
};

/**
 * A source in as few words as the device can say it without asking the server.
 *
 * The account id when there is one, because the case this list exists for is
 * two accounts at the same provider — "Dropbox" twice, one of them "showing",
 * is not a choice anyone can make. Not the account's name: that is written
 * onto a row only when the server is asked about it, which is only while it is
 * the one in front, so a list naming live sources by it would name a source
 * one way until it was shown and another way after.
 *
 * A detached source is named as its own panel names it (`sourceName`: by what
 * the server last called the account, which is what the user knows it by), and
 * says that it is disconnected and how much it holds. That is the whole reason
 * it is on the list, and a line that looked like any other source would leave
 * the user to find out by switching to it. The device's own pile is listed
 * only while it holds something (`connectedSources`), and is named for what it
 * is: not an account.
 */
const sourceLabel = (source: ConnectedSource): string => {
	if (source.connectionId === LOCAL_CONNECTION_ID) return 'On this device only';
	if (source.detached !== undefined) {
		return `${sourceName(source) ?? 'A source'} — disconnected, ${String(source.detached.unsent)} not sent`;
	}
	const provider = source.provider === undefined ? 'storage' : PROVIDER_LABELS[source.provider];
	return source.accountId === undefined ? provider : `${provider} · ${source.accountId}`;
};

/**
 * The devices holding this connection, and the way to take one away.
 *
 * The point of it is that a stolen credential is visible and revocable. It is
 * the compensating control for holding a bearer in IndexedDB, where `httpOnly`
 * cannot protect it (docs/PLAN.md §6), so it is asked for on open rather than
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
		void withHeld(database, client, connectionId)
			.then((authed) => (authed === undefined ? undefined : authed.revokeGrant(grantId)))
			.then((result) => {
				if (result?.ok === true) {
					ask();
					return;
				}
				setProblem('That device is still signed in: the server would not remove it.');
			})
			.catch(() => {
				setProblem('The server cannot be reached, so nothing was removed.');
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
 * The half of the disconnect confirm that the first half would otherwise make
 * untrue. "Its notes are removed" is about what the remote has; whatever it was
 * never sent is not removed, and the user is told how much that is and where
 * it will be, before they say yes rather than after.
 */
const StaysBehind = ({ unsent, label }: { unsent: number; label: string }) => {
	if (unsent === 0) return null;
	const one = unsent === 1;
	return (
		<p className="muted">
			{one
				? `1 change has not been sent to ${label}. It will stay`
				: `${String(unsent)} changes have not been sent to ${label}. They will stay`}{' '}
			on this device under this source, marked disconnected, until you reconnect, discard or
			download {one ? 'it' : 'them'}.
		</p>
	);
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
	onDisconnect: (connectionId: string) => Promise<void>;
	onUnbound: (connectionId: string) => void;
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
		(connectionId: string): Promise<void> => {
			if (pending.current.has(connectionId)) return Promise.resolve();
			pending.current.add(connectionId);
			put(connectionId, { busy: true, problem: null, stranded: false });
			return disconnectAccount(database, client, connectionId)
				.then((outcome) => {
					put(
						connectionId,
						outcome.ok
							? undefined
							: {
									busy: false,
									problem: refusalMessage(outcome.refusal),
									stranded: true,
								}
					);
				})
				.catch((error: unknown) => {
					put(connectionId, {
						busy: false,
						problem: failureMessage(error),
						stranded: true,
					});
				})
				.finally(() => {
					pending.current.delete(connectionId);
				});
		},
		[client, database, put]
	);

	const clear = useCallback(
		(connectionId: string) => {
			put(connectionId, undefined);
		},
		[put]
	);

	return { disconnects, disconnect, clear };
};

const Connected = ({
	client,
	database,
	sync,
	bound,
	config,
	account,
	disconnects,
	onDisconnect,
	onUnbound,
	returnTo,
	navigate,
}: ConnectedProps) => {
	const [confirming, setConfirming] = useState(false);
	// Only ever this source's. Named once per render, so the click below is
	// about the source the user was looking at when they pressed it.
	const connectionId = bound.connectionId;
	// What the confirm has to own up to: the changes here that the remote has
	// not had, which a disconnect will leave behind under this source. Live, so
	// that what the editors write when the confirm opens is counted in it.
	const unsent = useLiveQuery(
		async () => countOf(await unsyncedIn(database, connectionId)),
		[database, connectionId]
	);
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
	}, [confirming]);
	const confirm = (next: boolean) => {
		focusNext.current = next ? 'cancel' : 'open';
		setConfirming(next);
		// Whatever the editors still hold is written now, so that the count the
		// confirm gives is of everything the user has typed. Not waited for: the
		// count is live and follows the write.
		if (next) void settleEditors();
	};
	const cancel = useCallback(() => {
		focusNext.current = 'open';
		setConfirming(false);
	}, []);
	useEscape(panel, confirming, cancel);

	const label = bound.provider === undefined ? 'storage' : PROVIDER_LABELS[bound.provider];
	const displayName = accountName(answer(account), bound);

	const disconnect = () => {
		// Closing the confirm is this instance's to do, and nothing if it has
		// gone; what came of the disconnect is the panel's, and is kept.
		void onDisconnect(connectionId).finally(() => {
			confirm(false);
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
			<Sources
				client={client}
				database={database}
				config={config}
				returnTo={returnTo}
				{...(navigate === undefined ? {} : { navigate })}
			/>
			<Devices client={client} database={database} connectionId={bound.connectionId} />
			{problem !== null && (
				<p className="muted" role="alert">
					{problem}
				</p>
			)}
			{stranded && (
				<button
					type="button"
					className="ghost"
					onClick={() => {
						// Nothing is asked of the server, and nothing on it is touched.
						// By name: with none, this lets go of whichever source is in
						// front — another one's rows and cursor, while the one that
						// failed stays live on the server.
						void stopSyncingHere(database, connectionId).then(() => {
							onUnbound(connectionId);
						});
					}}
				>
					Stop syncing on this device
				</button>
			)}
			{confirming ? (
				<div className="account-confirm">
					<p className="muted">
						Disconnect {label}
						{displayName !== null && ` · ${displayName}`}? Its notes are removed from
						this device. Nothing is deleted from {label}; connect it again to get them
						back.
					</p>
					<StaysBehind unsent={unsent ?? 0} label={label} />
					<LeftAtProvider provider={bound.provider} />
					<button type="button" onClick={disconnect} disabled={busy}>
						Disconnect
					</button>
					<button
						ref={cancelButton}
						type="button"
						className="ghost"
						onClick={() => {
							confirm(false);
						}}
						disabled={busy}
					>
						Cancel
					</button>
				</div>
			) : (
				<button
					ref={openButton}
					type="button"
					className="ghost"
					// Not while the server is still being asked on open: its
					// answer could bind the device again right after. Nor while a
					// disconnect of this source is still out, which may have been
					// started before the user looked at another source and back.
					disabled={account.kind === 'asking' || busy}
					onClick={() => {
						confirm(true);
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
			sources={
				<Sources
					client={client}
					database={database}
					config={config}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
				/>
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
}: AccountPanelProps) => {
	const href = useRouterState({ select: (state) => state.location.href });
	// Wrapped: `first()` answers `undefined` for "no connection", and so does
	// `useLiveQuery` for "not read yet". Unwrapped, the two look the same.
	// The source the app is showing, not whichever `syncState` row IndexedDB
	// hands back first. A device may hold several connected sources at once
	// (docs/PLAN.md §6) and the first row is then a coin toss: the panel would
	// name one account while the notes on screen belong to another, and
	// switching sources would change nothing here. The live query reads `prefs`
	// as well as `syncState`, so a switch in another tab re-renders this one.
	const bound = useLiveQuery(
		async () => ({ state: await database.syncState.get(await activeConnectionId(database)) }),
		[database]
	);
	const [config, setConfig] = useState<Asked<InstanceConfig>>({ kind: 'asking' });
	const [account, setAccount] = useState<Asked<AccountState>>({ kind: 'asking' });
	const { disconnects, disconnect, clear } = useDisconnects(database, client);

	// A discard takes its source, and its panel, with it: the button the user
	// pressed is gone and the focus would fall to the page. It goes to the next
	// panel instead, once that has rendered — to the source list, which is what
	// is left to choose from, or failing that whatever the panel offers first.
	const frame = useRef<HTMLDivElement>(null);
	const landing = useRef(false);
	const showing = bound?.state?.connectionId ?? null;
	useEffect(() => {
		if (!landing.current) return;
		landing.current = false;
		const next =
			frame.current?.querySelector<HTMLElement>('.account-sources button') ??
			frame.current?.querySelector<HTMLElement>('button');
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
				onUnbound={clear}
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
	return <div ref={frame}>{panel()}</div>;
};
