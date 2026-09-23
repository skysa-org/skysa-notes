import { type ProviderKind } from '@skysa/core';
import { type ReactNode, useRef, useState } from 'react';

import { type ApiClient } from '../api/client.js';
import { failedAt, saying } from '../errors/reached.js';
import { pileContents } from '../store/connection.js';
import { beginConnect } from '../store/credentials.js';
import { type NotesDatabase } from '../store/db.js';
import { PROVIDER_LABELS } from '../sync/account.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Start connecting a storage account.
 *
 * A button and not a link, which is the whole of the change from Phase 6. The
 * device now generates the credential that will prove its right to the
 * connection and sends the server only its hash, so starting a flow means
 * writing a secret down and then posting a body — neither of which a navigation
 * can do. The server refuses a `GET` here for the same reason it has to: a link
 * carrying a caller-supplied hash, followed by a victim, would hand whoever
 * wrote the link a live credential to the victim's storage (docs/PLAN.md §6).
 *
 * The order is load-bearing and is the one thing to be careful of when editing
 * this. The credential is written to IndexedDB and **awaited** before the POST,
 * and the POST is answered before the browser goes anywhere. A consent the user
 * gives with nothing written down here is a connection on the server that this
 * device cannot reach and cannot revoke, holding a live refresh token, and the
 * only way out of it is another device.
 *
 * And before any of that, a question, when the device holds notes of its own.
 * Connecting any account moves them into it (`bindConnection`), and after that
 * there is no "this device only" to go back to — so the user is told what will
 * move, and where, and can stay as they are. Asked on every connect, not only
 * the first: whatever the pile holds goes into whichever account is next.
 */

export interface ConnectButtonProps {
	db: NotesDatabase;
	client: Pick<ApiClient, 'startConnect'>;
	provider: ProviderKind;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	children: ReactNode;
	className?: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
}

type Pile = Awaited<ReturnType<typeof pileContents>>;

const counted = (count: number, one: string, many: string) =>
	`${String(count)} ${count === 1 ? one : many}`;

/** "Your 2 notebooks and 5 notes …", leaving out a count of nothing. */
export const pileMoveMessage = ({ notebooks, notes }: Pile, provider: string): string => {
	const held = [
		...(notebooks > 0 ? [counted(notebooks, 'notebook', 'notebooks')] : []),
		...(notes > 0 ? [counted(notes, 'note', 'notes')] : []),
	].join(' and ');
	const them = notebooks + notes === 1 ? 'it' : 'them';
	return `Your ${held} on this device will move into ${provider} and sync there. Cancel to keep ${them} on this device only.`;
};

const MESSAGES: Partial<Record<string, string>> = {
	forbidden_origin: 'The server would not start connecting from this page. Reload and try again.',
	not_found: 'This deployment does not offer that provider.',
};

export const ConnectButton = ({
	db,
	client,
	provider,
	returnTo,
	children,
	className = 'button',
	navigate = (url) => {
		globalThis.location.assign(url);
	},
}: ConnectButtonProps) => {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	/** What would move, while the user is being asked about it. */
	const [asking, setAsking] = useState<Pile | null>(null);

	// Where the focus goes when the question does: the button that asked it,
	// named rather than left to whatever had the focus, which in Safari a
	// click on a button does not give it.
	const startButton = useRef<HTMLButtonElement>(null);

	const begin = (confirmed: boolean) => {
		setBusy(true);
		setFailed(null);
		setAsking(null);
		void (async () => {
			try {
				const pile = confirmed
					? undefined
					: await failedAt('device', () => pileContents(db));
				if (pile !== undefined && pile.notebooks + pile.notes > 0) {
					setAsking(pile);
					setBusy(false);
					return;
				}
				// Which half failed, said as each is called: writing the
				// credential down is this device's, asking where to send the
				// browser is the server's, and a message that named the wrong one
				// would send the user somewhere there is nothing to fix.
				const { credentialHash } = await failedAt('device', () =>
					beginConnect(db, provider)
				);
				const result = await failedAt('server', () =>
					client.startConnect(provider, credentialHash, returnTo)
				);
				if (!result.ok) {
					setFailed(
						MESSAGES[result.refusal] ??
							'The server would not start connecting. Try again.'
					);
					setBusy(false);
					return;
				}
				// Nothing after this line runs: the page is leaving.
				navigate(result.value);
			} catch (error) {
				setFailed(
					saying(error, {
						// "could not", against the refusal's "would not" above: one
						// is the server failing, the other the server deciding.
						answered: 'The server could not start connecting. Try again.',
						unreachable:
							'The server cannot be reached, so nothing was connected. Try again.',
						// The credential is written down before the server is
						// asked, so this half really did leave nothing connected.
						device: 'Something on this device went wrong, so nothing was connected. Try again.',
						// Neither call, so it is after the server answered, and
						// whether a flow was begun is not this to say.
						unknown: 'Something went wrong. Try again.',
					})
				);
				setBusy(false);
			}
		})();
	};

	return (
		<>
			<button
				ref={startButton}
				type="button"
				className={className}
				onClick={() => {
					begin(false);
				}}
				disabled={busy}
			>
				{children}
			</button>
			{asking !== null && (
				<ConfirmDialog
					title={`Move your notes to ${PROVIDER_LABELS[provider]}?`}
					confirmLabel="Connect and move"
					tone="primary"
					returnFocus={startButton}
					onConfirm={() => {
						begin(true);
					}}
					onCancel={() => {
						setAsking(null);
					}}
				>
					{pileMoveMessage(asking, PROVIDER_LABELS[provider])}
				</ConfirmDialog>
			)}
			{/*
			 * Announced, as the storage panel's own problems are: it replaces
			 * the thing the user just pressed for, and a reader that had moved
			 * on would otherwise be left waiting on a page that had answered.
			 */}
			{failed !== null && (
				<p className="muted" role="alert">
					{failed}
				</p>
			)}
		</>
	);
};
