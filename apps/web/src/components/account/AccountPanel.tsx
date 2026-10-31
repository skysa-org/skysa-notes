import { useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import { answer, type Asked, useInstanceConfig } from '../../api/instanceConfig.js';
import type { pickFiles } from '../../lib/pickFiles.js';
import { useDb } from '../../store/database.js';
import { activeConnectionId } from '../../store/db.js';
import { downloadLibrary, downloadUnsent, type Library } from '../../store/exportNotes.js';
import { type Keeping, keeping as browserKeeping } from '../../store/keeping.js';
import { isLiveSource } from '../../store/rowStates.js';
import type { Unsynced } from '../../store/unsynced.js';
import { type AccountState, claimConnection } from '../../sync/account.js';
import { syncScheduler } from '../../sync/runtime.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import type { Client, Sync } from './clients.js';
import { Connected } from './Connected.js';
import { Detached } from './Detached.js';
import { NotConnected } from './NotConnected.js';
import { useDisconnects } from './useDisconnects.js';

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

export interface AccountPanelProps {
	client?: Client;
	sync?: Sync;
	/**
	 * How to leave for the provider's consent page. Injected like the rest, and
	 * for the same reason: jsdom has no navigation, so a test that could not
	 * supply this could only ever prove the button renders.
	 */
	navigate?: (url: string) => void;
	/**
	 * How what a source never sent is handed to the user as a file, once its
	 * files' bytes are read (`downloadUnsent`). Injected for the same reason:
	 * jsdom cannot make a blob URL, so the real one cannot run in a test.
	 */
	download?: (library: Library) => void;
	/** How a whole source is handed to the user as a file, for the same reason. */
	downloadAll?: (library: Library) => void;
	/**
	 * Whether the browser keeps this device's notes. Injected for the same
	 * reason again: jsdom has no `navigator.storage`.
	 */
	keeping?: Keeping;
	/**
	 * How files are picked for an import (`ImportNotes`). Injected for the same
	 * reason again: jsdom opens no picker.
	 */
	pick?: typeof pickFiles;
	/**
	 * Where the panel's actions go as one `⋯` menu: the end of the showing
	 * source's row in a compact window's source dropdown, as every notebook's
	 * and note's row ends in its own (`SourcePanel`, `RowOptions`), with what
	 * another source's `⋯` asked of this one once it is showing. Left out, as at
	 * the foot of the sidebar, the actions are behind a gear at the end of the
	 * panel's line (`StatusLine`). Either way a connected source's panel is that
	 * one line — the source and how its syncing is going — with only what needs
	 * the user said above it, while it does.
	 */
	slot?: AccountSlot;
}

/** Back to exactly here, minus the outcome of any connect before this one. */
export const returnPath = (href: string): string => {
	const url = new URL(href, 'http://app.invalid');
	url.searchParams.delete('connect');
	url.searchParams.delete('code');
	return url.pathname + url.search;
};

export const AccountPanel = ({
	client = api,
	sync = syncScheduler,
	navigate,
	download = downloadLibrary,
	downloadAll = downloadLibrary,
	keeping = browserKeeping,
	pick,
	slot,
}: AccountPanelProps) => {
	const database = useDb();
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
	// The one request per client the bar's own asking shares (`useInstanceConfig`).
	const config = useInstanceConfig(client);
	const [account, setAccount] = useState<Asked<AccountState>>({ kind: 'asking' });
	const { disconnects, disconnect } = useDisconnects(client);
	// What a source never sent, with the files whose bytes are here. A file it
	// leaves out is the remote's, which still has it, so nothing is said of it.
	const downloadListed = (listed: Unsynced): Promise<void> =>
		downloadUnsent(database, listed, download);

	// A discard takes its source, and its panel, with it: the button the user
	// pressed is gone and the focus would fall to the page. It goes to the next
	// panel instead, once that has rendered — to whatever that panel offers
	// first, and failing that to the panel itself.
	//
	// The source list and the connect buttons have moved to the tab bar, so
	// discard the last source and what is left here is a sentence and the ways
	// to import, the first of which is where the focus goes. Where a panel
	// offers nothing at all, the frame takes `tabIndex={-1}` so there is
	// somewhere to land that says where the user is, rather than the body,
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
					config={config}
					returnTo={returnTo}
					downloadAll={downloadAll}
					keep={keeping}
					pick={pick}
					{...(navigate === undefined ? {} : { navigate })}
					{...(slot === undefined ? {} : { slot })}
				/>
			);
		}

		if (!isLiveSource(bound.state)) {
			return (
				<Detached
					key={bound.state.connectionId}
					client={client}
					config={config}
					bound={bound.state}
					download={downloadListed}
					onReleased={released}
					notice={disconnects[bound.state.connectionId]?.problem ?? null}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
					{...(slot === undefined ? {} : { slot })}
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
				download={downloadListed}
				downloadAll={downloadAll}
				{...(pick === undefined ? {} : { pick })}
				client={client}
				sync={sync}
				bound={bound.state}
				config={config}
				account={account}
				returnTo={returnTo}
				{...(navigate === undefined ? {} : { navigate })}
				{...(slot === undefined ? {} : { slot })}
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
