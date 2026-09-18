import { parentPath, type ProviderKind } from '@skysa/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import {
	api,
	type ApiClient,
	ApiError,
	type Connection,
	type Grant,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { folderToSearch } from '../routes/search.js';
import {
	type ConnectedSource,
	connectedSources,
	showConnection,
	unbindConnection,
} from '../store/connection.js';
import { credentialFor } from '../store/credentials.js';
import {
	activeConnectionId,
	db as defaultDb,
	type NotesDatabase,
	type QueuedOperation,
	type SyncStateRecord,
} from '../store/db.js';
import {
	type AccountState,
	adoptAccount,
	claimConnection,
	CONNECTABLE,
	disconnectAccount,
	LEFT_AT_PROVIDER,
	PROVIDER_LABELS,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type StuckOp, type SyncScheduler } from '../sync/scheduler.js';
import { ConnectButton } from './ConnectButton.js';

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
		async () => ({ note: await database.notes.get(noteId) }),
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
}: LocalProps & { config: Asked<InstanceConfig> }) => {
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
			{offerable.map((provider) => (
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
 * is not a choice anyone can make. It is the provider's own id rather than a
 * display name: the panel only ever asks the server about the source in front,
 * so a name for the others would mean holding answers this device has no
 * reason to keep.
 */
const sourceLabel = (source: ConnectedSource): string => {
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

interface ConnectedProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	config: Asked<InstanceConfig>;
	account: Asked<AccountState>;
	returnTo: string;
	navigate?: (url: string) => void;
}

const Connected = ({
	client,
	database,
	sync,
	bound,
	config,
	account,
	returnTo,
	navigate,
}: ConnectedProps) => {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	// Refused for want of a session: the server cannot be asked, and may even
	// have let go already, its answer lost on the way back.
	/**
	 * A disconnect the server would not or could not do, leaving the device
	 * bound to a connection it cannot get rid of by asking. Any failure counts:
	 * a refusal and an unreachable server strand the user the same way, and the
	 * old rule — only where the credential had stopped working — now names a
	 * case that cannot happen, because a credential the server no longer
	 * honours *is* the disconnect and `disconnectAccount` finishes the job.
	 *
	 * Held as the source it happened to, not as a flag: the button below lets
	 * go of exactly that one, whatever is in front by the time it is pressed.
	 */
	const [stranded, setStranded] = useState<string | null>(null);

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
	};

	const label = bound.provider === undefined ? 'storage' : PROVIDER_LABELS[bound.provider];
	const state = answer(account);
	const displayName =
		(state?.kind === 'connected' || state?.kind === 'other-account') &&
		state.connection.id === bound.connectionId
			? state.connection.displayName
			: null;

	const disconnect = () => {
		// Named once, when the user asked. The answer can take seconds, and it is
		// about this source whatever the panel is showing by then.
		const letting = bound.connectionId;
		setBusy(true);
		setProblem(null);
		setStranded(null);
		void disconnectAccount(database, client, letting)
			.then((outcome) => {
				if (outcome.ok) return;
				setProblem(refusalMessage(outcome.refusal));
				setStranded(letting);
			})
			.catch((error: unknown) => {
				setProblem(failureMessage(error));
				setStranded(letting);
			})
			.finally(() => {
				setBusy(false);
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
			{stranded === bound.connectionId && (
				<button
					type="button"
					className="ghost"
					onClick={() => {
						// Nothing is asked of the server, and nothing on it is touched.
						// By name: with none, this lets go of whichever source is in
						// front — another one's rows and cursor, while the one that
						// failed stays live on the server.
						void unbindConnection(database, { connectionId: stranded });
					}}
				>
					Stop syncing on this device
				</button>
			)}
			{confirming ? (
				<div className="account-confirm">
					<p className="muted">
						Disconnect {label}? Your notes stay on this device, and nothing is deleted
						from {label}.
					</p>
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
					// answer could bind the device again right after.
					disabled={account.kind === 'asking'}
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

interface OtherAccountProps {
	client: Client;
	database: NotesDatabase;
	connection: Connection;
	onSettled: (state: AccountState) => void;
}

/**
 * Signed in with an account the notes here do not belong to. Nothing has been
 * bound: the user either copies the notes into it or lets it go.
 */
const OtherAccount = ({ client, database, connection, onSettled }: OtherAccountProps) => {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const label = PROVIDER_LABELS[connection.provider];
	const name = connection.displayName ?? `this ${label} account`;

	const run = (work: () => Promise<AccountState | string>) => {
		setBusy(true);
		setProblem(null);
		void work()
			.then((outcome) => {
				if (typeof outcome === 'string') setProblem(outcome);
				else onSettled(outcome);
			})
			.catch(() => {
				setProblem('That did not work. Nothing has changed; try again.');
			})
			.finally(() => {
				setBusy(false);
			});
	};

	return (
		<section className="account" aria-label="Storage">
			<p>
				You connected {name}, but the notes on this device belong to another {label}{' '}
				account.
			</p>
			<p className="muted">Syncing with {name} copies every note on this device into it.</p>
			{problem !== null && (
				<p className="muted" role="alert">
					{problem}
				</p>
			)}
			<div className="account-confirm">
				<LeftAtProvider provider={connection.provider} />
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						run(() => adoptAccount(database, connection));
					}}
				>
					Copy notes into {name}
				</button>
				<button
					type="button"
					className="ghost"
					disabled={busy}
					onClick={() => {
						run(async () => {
							const outcome = await disconnectAccount(
								database,
								client,
								connection.id
							);
							return outcome.ok
								? { kind: 'none' }
								: 'The server would not disconnect it.';
						});
					}}
				>
					Disconnect {name}
				</button>
			</div>
		</section>
	);
};

export const AccountPanel = ({
	client = api,
	database = defaultDb,
	sync = syncScheduler,
	navigate,
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
	const named =
		answered?.kind === 'connected' || answered?.kind === 'other-account'
			? answered.connection.id
			: undefined;
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

	const state = answer(account);
	// Unless it has been answered already, in another tab.
	if (state?.kind === 'other-account' && bound.state?.connectionId !== state.connection.id) {
		return (
			<OtherAccount
				key={state.connection.id}
				client={client}
				database={database}
				connection={state.connection}
				onSettled={(settled) => {
					setAccount({ kind: 'answered', value: settled });
				}}
			/>
		);
	}

	return bound.state === undefined ? (
		<NotConnected
			client={client}
			database={database}
			config={config}
			returnTo={returnTo}
			{...(navigate === undefined ? {} : { navigate })}
		/>
	) : (
		// Keyed by source. Everything under here holds state about one source — a
		// disconnect that failed, a confirm half way through, a list of devices —
		// and unkeyed it survives "Show other source" and is rendered, and acted
		// on, under the other one's name.
		<Connected
			key={bound.state.connectionId}
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
