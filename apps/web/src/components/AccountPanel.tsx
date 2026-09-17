import { useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';

import {
	api,
	type ApiClient,
	ApiError,
	type Connection,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { unbindConnection } from '../store/connection.js';
import { db as defaultDb, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import {
	type AccountState,
	adoptAccount,
	CONNECTABLE,
	disconnectAccount,
	PROVIDER_LABELS,
	reconcileAccount,
} from '../sync/account.js';

/**
 * Where the storage account is connected and disconnected: one account, replace
 * or disconnect only (docs/PLAN.md, Phase 2).
 *
 * What the device is bound to is read from the store, so the panel is right
 * offline and the moment a bind lands. What the server says is asked once, on
 * open — which includes the return from the provider's consent page, since
 * that is a full navigation back into the app.
 */

type Client = Pick<ApiClient, 'config' | 'connections' | 'disconnect' | 'connectUrl'>;

export interface AccountPanelProps {
	client?: Client;
	database?: NotesDatabase;
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

interface ConnectedProps {
	client: Client;
	database: NotesDatabase;
	bound: SyncStateRecord;
	config: Asked<InstanceConfig>;
	account: Asked<AccountState>;
	returnTo: string;
}

const Connected = ({ client, database, bound, config, account, returnTo }: ConnectedProps) => {
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
		state?.kind === 'connected' && state.connection.id === bound.connectionId
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
			{state?.kind === 'signed-out' &&
				bound.provider !== undefined &&
				answer(config)?.authMode === 'storage-first' && (
					<p className="muted">
						Your session has ended.{' '}
						<a href={client.connectUrl(bound.provider, returnTo)}>Connect again</a>
					</p>
				)}
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

export const AccountPanel = ({ client = api, database = defaultDb }: AccountPanelProps) => {
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
		void reconcileAccount(database, client)
			.then((value) => {
				setAccount({ kind: 'answered', value });
			})
			.catch(() => {
				setAccount({ kind: 'unreachable' });
			});
	}, [client, database]);

	if (bound === undefined) return null;
	const returnTo = returnPath(href);

	const state = answer(account);
	if (state?.kind === 'other-account') {
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
			bound={bound.state}
			config={config}
			account={account}
			returnTo={returnTo}
		/>
	);
};
