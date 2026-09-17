import { useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';

import { api, type ApiClient, type InstanceConfig, type Refusal } from '../api/client.js';
import { db as defaultDb, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import {
	type AccountState,
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
		? 'Your session has ended. Connect again, then disconnect.'
		: 'The server would not disconnect this account.';

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
	account: Asked<AccountState>;
	returnTo: string;
}

const Connected = ({ client, database, bound, account, returnTo }: ConnectedProps) => {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

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
				if (!outcome.ok) setProblem(refusalMessage(outcome.refusal));
			})
			.catch(() => {
				setProblem('The server cannot be reached, so the account is still connected.');
			})
			.finally(() => {
				setBusy(false);
				setConfirming(false);
			});
	};

	return (
		<section className="account" aria-label="Storage">
			<p>
				Syncing with {label}
				{displayName !== null && <span className="muted"> · {displayName}</span>}
			</p>
			{state?.kind === 'signed-out' && bound.provider !== undefined && (
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
						type="button"
						className="ghost"
						onClick={() => {
							setConfirming(false);
						}}
						disabled={busy}
					>
						Cancel
					</button>
				</div>
			) : (
				<button
					type="button"
					className="ghost"
					onClick={() => {
						setConfirming(true);
					}}
				>
					Disconnect…
				</button>
			)}
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

	return bound.state === undefined ? (
		<NotConnected client={client} config={config} returnTo={returnTo} />
	) : (
		<Connected
			client={client}
			database={database}
			bound={bound.state}
			account={account}
			returnTo={returnTo}
		/>
	);
};
