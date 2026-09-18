import { type ProviderKind } from '@skysa/core';
import { type ReactNode, useState } from 'react';

import { type ApiClient } from '../api/client.js';
import { beginConnect } from '../store/credentials.js';
import { type NotesDatabase } from '../store/db.js';

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

	const begin = () => {
		setBusy(true);
		setFailed(null);
		void (async () => {
			try {
				const { credentialHash } = await beginConnect(db, provider);
				const result = await client.startConnect(provider, credentialHash, returnTo);
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
			} catch {
				setFailed('The server cannot be reached, so nothing was connected.');
				setBusy(false);
			}
		})();
	};

	return (
		<>
			<button type="button" className={className} onClick={begin} disabled={busy}>
				{children}
			</button>
			{failed !== null && <p className="muted">{failed}</p>}
		</>
	);
};
