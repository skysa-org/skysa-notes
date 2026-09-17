import { parentPath, type ProviderKind } from '@skysa/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useEffect, useRef, useState } from 'react';

import {
	api,
	type ApiClient,
	ApiError,
	type Connection,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { folderToSearch } from '../routes/search.js';
import { unbindConnection } from '../store/connection.js';
import {
	db as defaultDb,
	type NotesDatabase,
	type QueuedOperation,
	type SyncStateRecord,
} from '../store/db.js';
import {
	type AccountState,
	adoptAccount,
	CONNECTABLE,
	disconnectAccount,
	LEFT_AT_PROVIDER,
	PROVIDER_LABELS,
	reconcileAccount,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type StuckOp, type SyncScheduler } from '../sync/scheduler.js';

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

type Client = Pick<ApiClient, 'config' | 'connections' | 'disconnect' | 'connectUrl'>;

type Sync = Pick<SyncScheduler, 'status' | 'subscribe' | 'syncNow' | 'resync'>;

export interface AccountPanelProps {
	client?: Client;
	database?: NotesDatabase;
	sync?: Sync;
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

const refusalMessage = (refusal: Refusal): string =>
	refusal === 'sign_in_required'
		? 'Your session has ended, so the server cannot be asked to disconnect. Connect again, then disconnect — or stop syncing on this device only.'
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
	(status.refusal === 'sign_in_required' ||
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
	config: Asked<InstanceConfig>;
	returnTo: string;
}

const NotConnected = ({ client, config, returnTo }: LocalProps) => {
	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];

	return (
		<section className="account" aria-label="Storage">
			<p className="muted">Notes are kept on this device only.</p>
			{offerable.map((provider) => (
				<a key={provider} className="button" href={client.connectUrl(provider, returnTo)}>
					Connect {PROVIDER_LABELS[provider]}
				</a>
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
	if (note === undefined || note.deletedLocally === 1) return null;
	return (
		<Link to="/" search={{ folder: folderToSearch(parentPath(note.path)), note: note.id }}>
			Open the note
		</Link>
	);
};

interface SyncStateProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	label: string;
	/** The server said there is no session. */
	signedOut: boolean;
	/** This server lets the user connect storage from here. */
	reconnectable: boolean;
	returnTo: string;
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
	signedOut,
	reconnectable,
	returnTo,
}: SyncStateProps) => {
	const status = useSyncStatus(sync);
	const syncable = bound.provider !== undefined && CONNECTABLE.includes(bound.provider);
	const message = statusMessage(status, label, syncable);
	const reconnect = signedOut || needsReconnect(status);
	const [rescanning, setRescanning] = useState(false);

	return (
		<>
			{/* Said even where there is no link to offer: sync has stopped. */}
			{reconnect && (
				<p className="muted">
					{status.refusal === 'reauthorize_required' ||
					status.error === 'authorization required'
						? `${label} needs to be connected again.`
						: 'Your session has ended.'}
					{reconnectable && bound.provider !== undefined && (
						<>
							{' '}
							<a href={client.connectUrl(bound.provider, returnTo)}>Connect again</a>
						</>
					)}
				</p>
			)}
			{message !== null && <p className="muted">{message}</p>}
			{status.stuck?.noteId !== undefined && (
				<p className="muted">
					<StuckNote database={database} noteId={status.stuck.noteId} />
				</p>
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
				(rescanning ? (
					<div className="account-confirm">
						<p className="muted">
							Read everything in {label} again? This device compares every note with
							the folder from scratch. Notes that are no longer in {label} are removed
							here too, unless they have edits that have not been sent.
						</p>
						<button
							type="button"
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

interface ConnectedProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	config: Asked<InstanceConfig>;
	account: Asked<AccountState>;
	returnTo: string;
}

const Connected = ({
	client,
	database,
	sync,
	bound,
	config,
	account,
	returnTo,
}: ConnectedProps) => {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	// Refused for want of a session: the server cannot be asked, and may even
	// have let go already, its answer lost on the way back.
	const [sessionless, setSessionless] = useState(false);

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
		setBusy(true);
		setProblem(null);
		void disconnectAccount(database, client, bound.connectionId)
			.then((outcome) => {
				if (outcome.ok) return;
				setProblem(refusalMessage(outcome.refusal));
				setSessionless(outcome.refusal === 'sign_in_required');
			})
			.catch((error: unknown) => {
				setProblem(failureMessage(error));
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
				signedOut={state?.kind === 'signed-out'}
				reconnectable={answer(config)?.authMode === 'storage-first'}
				returnTo={returnTo}
			/>
			{problem !== null && (
				<p className="muted" role="alert">
					{problem}
				</p>
			)}
			{sessionless && (
				<button
					type="button"
					className="ghost"
					onClick={() => {
						// Nothing is asked of the server, and nothing on it is touched.
						void unbindConnection(database);
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
}: AccountPanelProps) => {
	const href = useRouterState({ select: (state) => state.location.href });
	// Wrapped: `first()` answers `undefined` for "no connection", and so does
	// `useLiveQuery` for "not read yet". Unwrapped, the two look the same.
	const bound = useLiveQuery(
		async () => ({ state: await database.syncState.toCollection().first() }),
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
		void reconcileAccount(database, client)
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
		<NotConnected client={client} config={config} returnTo={returnTo} />
	) : (
		<Connected
			client={client}
			database={database}
			sync={sync}
			bound={bound.state}
			config={config}
			account={account}
			returnTo={returnTo}
		/>
	);
};
