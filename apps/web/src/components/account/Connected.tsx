import { useLiveQuery } from 'dexie-react-hooks';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { Grant, InstanceConfig } from '../../api/client.js';
import { answer, type Asked } from '../../api/instanceConfig.js';
import type { pickFiles } from '../../editor/pickFiles.js';
import { t } from '../../i18n/t.js';
import { tabLock } from '../../secrets/tabLock.js';
import { setClipboardShown, showsClipboard } from '../../store/clipboard.js';
import { connectedSources } from '../../store/connection.js';
import type { NotesDatabase, SyncStateRecord } from '../../store/db.js';
import { holdsAnything, type Library } from '../../store/exportNotes.js';
import type { Unsynced } from '../../store/unsynced.js';
import {
	type AccountState,
	type LetGoInput,
	PROVIDER_LABELS,
	type UnsentAnswer,
} from '../../sync/account.js';
import { useSyncStatus } from '../../sync/runtime.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import { ClipboardPanel } from '../ClipboardPanel.js';
import { DisconnectDialog } from '../DisconnectDialog.js';
import { type Importing, importItems, ImportNotes, useImportNotes } from '../ImportNotes.js';
import { otherLiveSources } from '../MoveUnsent.js';
import { SecretsDialog } from '../secrets/SecretsDialog.js';
import type { SecretsDialogProps } from '../secrets/types.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import { DialogActions, InlineDialog } from '../ui/Dialog.js';
import { useEscape } from '../ui/useEscape.js';
import type { Client, Sync } from './clients.js';
import { Devices, stillSignedIn, useGrants } from './Devices.js';
import { DownloadAll, type Downloading, downloadItem, useDownloadAll } from './DownloadAll.js';
import { ActionsMenu, GearMenu, useMenuButtons } from './PanelMenus.js';
import { StatusLine, SyncBar, SyncDetails } from './StatusLine.js';
import { lineStatus, syncCount } from './statusWords.js';
import {
	clipboardItem,
	stoppedBy,
	storageItems,
	useScratchpadItem,
	useSecretsItem,
	worthPushing,
} from './storageItems.js';
import { LeftAtProvider, UnseenDialog, unseenItem } from './SyncNotices.js';
import { importingHere, isSyncable, SyncState } from './SyncState.js';
import { useAsked } from './useAsked.js';
import { type Disconnecting, prepare } from './useDisconnects.js';

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

export const Connected = ({
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
