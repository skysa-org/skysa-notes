import { useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';

import { api, type Grant, type InstanceConfig } from '../api/client.js';
import { answer, type Asked } from '../api/instanceConfig.js';
import { type pickFiles } from '../editor/pickFiles.js';
import { t } from '../i18n/t.js';
import { tabLock } from '../secrets/tabLock.js';
import { setClipboardShown, showsClipboard } from '../store/clipboard.js';
import { connectedSources } from '../store/connection.js';
import {
	activeConnectionId,
	db as defaultDb,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	type SyncStateRecord,
} from '../store/db.js';
import {
	downloadLibrary,
	downloadNotice,
	downloadProblem,
	downloadSource,
	downloadUnsent,
	holdsAnything,
	type Library,
} from '../store/exportNotes.js';
import { type Keeping, keeping as browserKeeping } from '../store/keeping.js';
import { isLiveSource } from '../store/rowStates.js';
import { type Unsynced } from '../store/unsynced.js';
import {
	type AccountState,
	claimConnection,
	CONNECTABLE,
	type LetGoInput,
	PROVIDER_LABELS,
	type UnsentAnswer,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus } from '../sync/scheduler.js';
import { type Client, type Sync } from './account/clients.js';
import { Devices, stillSignedIn, useGrants } from './account/Devices.js';
import { ActionsMenu, GearMenu, useMenuButtons } from './account/PanelMenus.js';
import { StatusLine, SyncBar, SyncDetails } from './account/StatusLine.js';
import { lineStatus, syncCount } from './account/statusWords.js';
import {
	clipboardItem,
	stoppedBy,
	storageItems,
	useScratchpadItem,
	useSecretsItem,
	worthPushing,
} from './account/storageItems.js';
import { LeftAtProvider, UnseenDialog, unseenItem } from './account/SyncNotices.js';
import { importingHere, isSyncable, SyncState } from './account/SyncState.js';
import { type Disconnecting, prepare, useDisconnects } from './account/useDisconnects.js';
import { ClipboardPanel } from './ClipboardPanel.js';
import { ConnectButton } from './ConnectButton.js';
import { DetachedSource } from './DetachedSource.js';
import { DialogActions, InlineDialog } from './Dialog.js';
import { DisconnectDialog } from './DisconnectDialog.js';
import { type Importing, importItems, ImportNotes, useImportNotes } from './ImportNotes.js';
import { otherLiveSources } from './MoveUnsent.js';
import { type OptionsMenuItem } from './OptionsMenu.js';
import { SecretsDialog, type SecretsDialogProps } from './SecretsDialog.js';
import { type AccountSlot, type SourceAsk } from './SourceTabs.js';
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

interface LocalProps {
	client: Client;
	database: NotesDatabase;
	config: Asked<InstanceConfig>;
	returnTo: string;
	navigate?: (url: string) => void;
	slot?: AccountSlot;
}

/**
 * What another source's `⋯` asked of this one (`SourceAsk`), once this one is
 * showing and can do it: `act` is told it and answers whether it is done, and
 * the ask is let go once it is, or once it cannot be — the panel offers no
 * such thing for this source after all. Asked again on every render until
 * then, since what it waits for (the server's answer, a count of the notes
 * here) arrives as a render.
 */
const useAsked = (
	slot: AccountSlot | undefined,
	connectionId: string,
	act: (action: SourceAsk['action']) => boolean
) => {
	const wanted = slot?.asked?.connectionId === connectionId ? slot.asked.action : undefined;
	const onAsked = slot?.onAsked;
	useEffect(() => {
		if (wanted === undefined || onAsked === undefined) return;
		if (act(wanted)) onAsked();
	});
};

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
const useDownloadAll = (
	database: NotesDatabase,
	connectionId: string,
	downloadAll: (library: Library) => void
) => {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const start = () => {
		setBusy(true);
		setProblem(null);
		void downloadSource(database, connectionId, downloadAll)
			.then((answer) => {
				setProblem(downloadNotice(answer));
			})
			.catch((error: unknown) => {
				setProblem(downloadProblem(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};
	return { busy, problem, start };
};

type Downloading = ReturnType<typeof useDownloadAll>;

/** What went wrong with the download, said where it was asked for. */
const DownloadAll = ({
	holds,
	downloading,
}: {
	/** `holdsAnything`, as the panel has read it: undefined until it has. */
	holds: boolean | undefined;
	downloading: Downloading;
}) =>
	holds === true && downloading.problem !== null ? (
		<p className="muted" role="alert">
			{downloading.problem}
		</p>
	) : null;

/** The way to start it, as an item of the gear's menu or the `⋯`. */
const downloadItem = (holds: boolean | undefined, downloading: Downloading): OptionsMenuItem[] =>
	holds === true
		? [
				{
					label: t('account.menu.downloadAll'),
					onChoose: downloading.start,
					disabled: downloading.busy,
				},
			]
		: [];

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
	downloadAll,
	keep,
	slot,
	pick,
}: LocalProps & {
	downloadAll: (library: Library) => void;
	keep: Keeping;
	pick: typeof pickFiles | undefined;
}) => {
	const settings = answer(config);
	const holds = useLiveQuery(() => holdsAnything(database, LOCAL_CONNECTION_ID), [database]);
	const downloading = useDownloadAll(database, LOCAL_CONNECTION_ID, downloadAll);
	const importing = useImportNotes(database, LOCAL_CONNECTION_ID, {
		label: t('account.thisDevice'),
		syncs: false,
		...(pick === undefined ? {} : { pick }),
	});
	useAsked(slot, LOCAL_CONNECTION_ID, (action) => {
		if (action !== 'download') return true;
		if (holds === undefined) return false;
		if (holds) downloading.start();
		return true;
	});
	const kept = useKept(keep);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];
	const scratchpad = useScratchpadItem(database, LOCAL_CONNECTION_ID);
	const items = [
		...downloadItem(holds, downloading),
		...importItems(importing, { scratchpad: scratchpad.shown === true }),
		...scratchpad.items,
	];

	return (
		<section className="account" aria-label={t('account.region')}>
			{/* Where the notes are is said by the status line. The way to
			    connect is beside it in the bar above, in words, at the foot of
			    the sidebar; in a compact window's source dropdown it is the `+`
			    in its header, which never has words, so it is said here. */}
			{slot !== undefined && offerable.length > 0 && (
				<p className="muted">{t('account.local.useAdd')}</p>
			)}
			{settings?.authMode === 'account-first' && (
				<p className="muted">{t('account.local.signInMissing')}</p>
			)}
			{config.kind === 'unreachable' && (
				<p className="muted">{t('account.local.unreachable')}</p>
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
				<p className="muted">{t('account.local.mayClear')}</p>
			)}
			<DownloadAll holds={holds} downloading={downloading} />
			<ImportNotes importing={importing} />
			<StatusLine text={t('account.local.line')} title={null}>
				<GearMenu items={items} />
			</StatusLine>
			{slot !== undefined && <ActionsMenu slot={slot} items={items} />}
		</section>
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
	onDisconnect: (connectionId: string, answer: Omit<LetGoInput, 'connectionId'>) => Promise<void>;
	/** Hand the notes that were never sent to the user as a file. */
	download: (listed: Unsynced) => Promise<void>;
	/** Hand the whole source to the user as a file. */
	downloadAll: (library: Library) => void;
	pick?: typeof pickFiles;
	returnTo: string;
	navigate?: (url: string) => void;
	slot?: AccountSlot;
}

/**
 * Where a connected source's panel ends: the status line (`StatusLine`), with
 * how syncing is going, the count of the other devices, and the gear. In a
 * compact window's source dropdown the gear's items are also the `⋯` at the
 * end of the source's row, as every source's row has one. Either menu also
 * opens what the provider keeps from the app, said over everything, the line
 * having no room for it.
 */
const ConnectedFoot = ({
	slot,
	bound,
	status,
	label,
	displayName,
	openButton,
	client,
	database,
	grants,
	onGrantsChanged,
	downloadable,
	holds,
	downloading,
	importing,
	onClipboard,
	secrets,
	onSecrets,
	keyFile,
	onPause,
	...actions
}: Omit<
	Parameters<typeof storageItems>[0],
	'about' | 'phase' | 'download' | 'imports' | 'clipboard' | 'scratchpad' | 'secrets'
> & {
	slot: AccountSlot | undefined;
	/** Show or hide the clipboard. */
	onClipboard: () => void;
	/** Whether secrets for the source are open (`SecretsDialog`), and opening or closing them. */
	secrets: boolean;
	onSecrets: (open: boolean) => void;
	keyFile: SecretsDialogProps['keyFile'];
	/** Pause syncing, from its details (`SyncDetails`). */
	onPause: () => void;
	/**
	 * Whether the source can be downloaded or imported into now: not while a
	 * first import is filling it, nor while the disconnect question is open.
	 */
	downloadable: boolean;
	holds: boolean | undefined;
	downloading: Downloading;
	importing: Importing;
	status: SchedulerStatus;
	label: string;
	displayName: string | null;
	/**
	 * The gear, or the source's `⋯`, whichever was opened last: where the
	 * focus goes back to once a question is put away (`useMenuButtons`).
	 */
	openButton: RefObject<HTMLButtonElement | null>;
	client: Client;
	database: NotesDatabase;
	grants: Asked<Grant[]>;
	onGrantsChanged: () => void;
}) => {
	const [about, setAbout] = useState(false);
	const [details, setDetails] = useState(false);
	const detailsButton = useRef<HTMLButtonElement>(null);
	// Not while a first import holds the source: its dialog says all of it,
	// and has its own way out. Nor while nothing syncs it, when the line is
	// the source's name and has nothing to open.
	const tappable = !importingHere(bound) && status.phase !== 'local';
	const menus = useMenuButtons(openButton);
	const scratchpad = useScratchpadItem(database, bound.connectionId);
	const secretsItems = useSecretsItem(database, bound, status.phase, () => {
		onSecrets(true);
	});
	const items = storageItems({
		...actions,
		bound,
		phase: status.phase,
		download: downloadable ? downloadItem(holds, downloading) : [],
		imports: downloadable
			? importItems(importing, { scratchpad: scratchpad.shown === true })
			: [],
		clipboard: clipboardItem(bound, status.phase, onClipboard),
		// Not while a first import holds the source, as the clipboard is not.
		scratchpad: importingHere(bound) ? [] : scratchpad.items,
		secrets: secretsItems,
		about: unseenItem(bound.provider, label, () => {
			setAbout(true);
		}),
	});
	const said = lineStatus(status, label, isSyncable(bound));
	const count = syncCount(status.progress, label);
	// Who the account is, which the line has no room for, and the whole of
	// what it says about syncing, where that is more than its few words.
	const title = [
		displayName === null
			? t('account.title.syncing', { provider: label })
			: t('account.title.syncingAs', { provider: label, account: displayName }),
		said.title,
	]
		.filter((line) => line !== null)
		.join('\n');
	return (
		<>
			{secrets && (
				<SecretsDialog
					database={database}
					connectionId={bound.connectionId}
					sourceName={slot?.name ?? label}
					keyFile={keyFile}
					lock={tabLock}
					onClose={() => {
						onSecrets(false);
					}}
					returnFocus={openButton}
				/>
			)}
			{about && (
				<UnseenDialog
					provider={bound.provider}
					onClose={() => {
						setAbout(false);
					}}
					returnFocus={openButton}
				/>
			)}
			{details && (
				<SyncDetails
					status={status}
					label={label}
					displayName={displayName}
					syncable={isSyncable(bound)}
					onPause={onPause}
					onResume={actions.syncNow}
					onClose={() => {
						setDetails(false);
					}}
					returnFocus={detailsButton}
				/>
			)}
			<StatusLine
				text={said.text}
				title={title}
				{...(tappable
					? {
							onDetails: () => {
								setDetails(true);
							},
							detailsRef: detailsButton,
						}
					: {})}
			>
				<Devices
					client={client}
					database={database}
					connectionId={bound.connectionId}
					grants={grants}
					onChanged={onGrantsChanged}
					gear={openButton}
				/>
				<GearMenu items={items} triggerRef={menus.gear} onOpen={menus.onGear} />
			</StatusLine>
			{count !== undefined && <SyncBar count={count} />}
			{slot !== undefined && (
				<ActionsMenu
					slot={slot}
					items={items}
					triggerRef={menus.dots}
					onOpen={menus.onDots}
				/>
			)}
		</>
	);
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

/** How an import into a connected source names it, and picks its files. */
const importInto = (bound: SyncStateRecord, pick: typeof pickFiles | undefined) => ({
	label:
		bound.provider === undefined ? t('account.someStorage') : PROVIDER_LABELS[bound.provider],
	syncs: true,
	...(pick === undefined ? {} : { pick }),
});

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
	pick,
	returnTo,
	navigate,
	slot,
}: ConnectedProps) => {
	const [step, setStep] = useState<Step>({ kind: 'closed' });
	const [rescanning, setRescanning] = useState(false);
	const [secrets, setSecrets] = useState(false);
	const [trouble, setTrouble] = useState<string | null>(null);
	const status = useSyncStatus(sync);
	// Only ever this source's. Named once per render, so the click below is
	// about the source the user was looking at when they pressed it.
	const connectionId = bound.connectionId;
	const holds = useLiveQuery(
		() => holdsAnything(database, connectionId),
		[database, connectionId]
	);
	const downloading = useDownloadAll(database, connectionId, downloadAll);
	const importing = useImportNotes(database, connectionId, importInto(bound, pick));
	// The other live sources, which what this one never sent could go to.
	const sources = useLiveQuery(() => connectedSources(database), [database]);
	const targets = otherLiveSources(sources, connectionId);
	// Here rather than in the list, because the question counts them too.
	const devices = useGrants(client, database, connectionId);
	const disconnecting = disconnects[connectionId];
	const busy = disconnecting?.busy === true;
	const problem = disconnecting?.problem ?? null;
	const stranded = disconnecting?.stranded === true;
	// The question takes the focus as every question does (`InlineDialog`);
	// closed, the focus goes back to the menu it was asked from, rather than
	// falling to the page when the button pressed goes away.
	const focusBack = useRef(false);
	const openButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	// Which question the answer coming back belongs to (`ask`).
	const asking = useRef(0);
	const open = step.kind !== 'closed';
	useEffect(() => {
		// Only focus that is still here to move. A disconnect can take seconds
		// to answer, and a user who went back to a note meanwhile keeps typing
		// into the note, not into a button.
		const focused = document.activeElement;
		const here =
			focused === null ||
			focused === document.body ||
			panel.current?.contains(focused) === true;
		if (focusBack.current && here) openButton.current?.focus();
		focusBack.current = false;
	}, [step.kind]);
	const cancel = useCallback(() => {
		// A question nobody is waiting for the answer to: whatever the last push
		// is doing, it can go on doing.
		asking.current += 1;
		focusBack.current = true;
		setStep({ kind: 'closed' });
	}, []);
	useEscape(panel, open, cancel);

	const label =
		bound.provider === undefined ? t('account.someStorage') : PROVIDER_LABELS[bound.provider];
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
		setTrouble(null);
		setStep({ kind: 'pushing', onServer });
		// Again, for the question's sake: whether this is the last device decides
		// what it says, and a device may have joined since the panel opened.
		if (onServer) devices.ask();
		void prepare(database, connectionId, pushable ? () => sync.syncNow() : undefined)
			.then((ready) => {
				if (asking.current !== mine) return;
				setStep({ kind: 'asking', onServer, ...ready });
			})
			.catch(() => {
				if (asking.current !== mine) return;
				setStep({ kind: 'closed' });
				setTrouble(t('account.disconnect.unreadable'));
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

	const downloadable = bound.importing === undefined && !open;
	// Not while the server is still being asked on open: its answer could bind
	// the device again right after. Nor while a disconnect of this source is
	// still out, which may have been started before the user looked at another
	// source and back.
	const disconnectBlocked = account.kind === 'asking' || busy;
	// Asked from this source's row before it was showing: done as its own
	// item here would do it, once it can be, and dropped where it would not
	// be offered.
	useAsked(slot, connectionId, (action) => {
		if (action === 'download') {
			if (!downloadable) return true;
			if (holds === undefined) return false;
			if (holds) downloading.start();
			return true;
		}
		if (action === 'rescan') {
			if (!isSyncable(bound) || importingHere(bound)) return true;
			if (status.phase === 'local') return false;
			setRescanning(true);
			return true;
		}
		if (action === 'secrets') {
			if (importingHere(bound)) return true;
			if (status.phase === 'local') return false;
			setSecrets(true);
			return true;
		}
		if (open) return true;
		if (disconnectBlocked) return false;
		ask(true);
		return true;
	});

	return (
		<>
			{/* Its own section, before the storage panel and ruled off from it
			    the width of the sidebar: what is on it is the user's, not how
			    the source is doing. */}
			{showsClipboard(bound) && (
				<ClipboardPanel
					connectionId={connectionId}
					database={database}
					sync={sync}
					{...(pick === undefined ? {} : { pick })}
				/>
			)}
			<section ref={panel} className="account" aria-label={t('account.region')}>
				<SyncState
					client={client}
					database={database}
					sync={sync}
					bound={bound}
					label={label}
					reconnectable={answer(config)?.authMode === 'storage-first'}
					config={config}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
					rescanning={rescanning}
					onRescanning={setRescanning}
				/>
				{/*
				 * Not while an import is filling the source, when the archive would be
				 * whatever part of it had arrived; nor while the disconnect question
				 * is open, which offers its own download of what was never sent.
				 */}
				{downloadable && <DownloadAll holds={holds} downloading={downloading} />}
				{/*
				 * Held back as the download is, and for a like reason: notes written
				 * in while a first import is filling the source would meet its files
				 * as they arrive, and an import beside the disconnect question would
				 * add to the very list being asked about.
				 */}
				{downloadable && <ImportNotes importing={importing} />}
				{(problem ?? trouble) !== null && (
					<p className="muted" role="alert">
						{problem ?? trouble}
					</p>
				)}
				{step.kind === 'pushing' && (
					<InlineDialog
						className="account-confirm"
						label={t('account.disconnect.sending')}
						onClose={cancel}
					>
						<p className="muted">{t('account.disconnect.sendingNow')}</p>
						<DialogActions />
					</InlineDialog>
				)}
				{step.kind === 'asking' && (
					<DisconnectDialog
						label={label}
						displayName={displayName}
						listed={step.listed}
						targets={targets}
						failing={step.failing}
						busy={busy}
						others={stillSignedIn(devices.grants)}
						onServer={step.onServer}
						leftAtProvider={<LeftAtProvider provider={bound.provider} />}
						stopped={stoppedBy(status, step.listed)}
						download={download}
						onAnswer={answered}
						onCancel={cancel}
					/>
				)}
				<ConnectedFoot
					slot={slot}
					bound={bound}
					status={status}
					label={label}
					displayName={displayName}
					rescanning={rescanning}
					onRescan={() => {
						setRescanning(true);
					}}
					downloadable={downloadable}
					holds={holds}
					downloading={downloading}
					importing={importing}
					stranded={stranded}
					open={open}
					disconnectBlocked={disconnectBlocked}
					syncNow={() => {
						void sync.syncNow();
					}}
					onPause={() => {
						sync.pause();
					}}
					secrets={secrets}
					onSecrets={setSecrets}
					keyFile={sync.keyFile}
					onClipboard={() => {
						const shown = showsClipboard(bound);
						void setClipboardShown(database, connectionId, !shown).then(() => {
							if (!shown) void sync.clipboard.refresh(connectionId);
						});
					}}
					ask={ask}
					openButton={openButton}
					client={client}
					database={database}
					grants={devices.grants}
					onGrantsChanged={devices.ask}
				/>
			</section>
		</>
	);
};

interface DetachedProps extends LocalProps {
	bound: SyncStateRecord;
	download: (listed: Unsynced) => Promise<void>;
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
	slot,
}: DetachedProps) => {
	const settings = answer(config);
	const provider = bound.provider;
	const reconnectable =
		provider !== undefined &&
		CONNECTABLE.includes(provider) &&
		settings?.authMode === 'storage-first' &&
		settings.providers.includes(provider);
	return (
		<>
			{/*
			 * Its own choices are what to do with what it holds, each a question
			 * with its answers beside it, and they stay in the panel; the menu is
			 * there, empty, so its row has the shape the others have.
			 */}
			{slot !== undefined && <ActionsMenu slot={slot} items={[]} />}
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
							{t('account.reconnect.detached')}
						</ConnectButton>
					)
				}
			/>
		</>
	);
};

export const AccountPanel = ({
	client = api,
	database = defaultDb,
	sync = syncScheduler,
	navigate,
	download = downloadLibrary,
	downloadAll = downloadLibrary,
	keeping = browserKeeping,
	pick,
	slot,
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
					database={database}
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
				database={database}
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
