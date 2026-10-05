import { parentPath, type ProviderKind, type SyncProgress } from '@skysa/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	Fragment,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';

import {
	api,
	type ApiClient,
	type Grant,
	type InstanceConfig,
	type Refusal,
} from '../api/client.js';
import { answer, type Asked } from '../api/instanceConfig.js';
import { Icon } from '../editor/icons.js';
import { type pickFiles } from '../editor/pickFiles.js';
import { failedAt, saying } from '../errors/reached.js';
import { folderToSearch } from '../routes/search.js';
import { connectedSources } from '../store/connection.js';
import { credentialFor } from '../store/credentials.js';
import {
	activeConnectionId,
	db as defaultDb,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	type QueuedOperation,
	type SyncStateRecord,
} from '../store/db.js';
import { holdsTextFor } from '../store/detached.js';
import {
	downloadLibrary,
	downloadNotice,
	downloadProblem,
	downloadSource,
	downloadUnsent,
	holdsAnything,
	type Library,
} from '../store/exportNotes.js';
import { settleEditors } from '../store/heldEdits.js';
import { type Keeping, keeping as browserKeeping } from '../store/keeping.js';
import { getNote } from '../store/notes.js';
import { type Seen, seenIn, type Unsynced, unsyncedIn } from '../store/unsynced.js';
import {
	type AccountState,
	claimConnection,
	CONNECTABLE,
	LEFT_AT_PROVIDER,
	type LetGoInput,
	letGoOfSource,
	type LetGoResult,
	PROVIDER_LABELS,
	refusedMessage,
	UNSEEN_AT_PROVIDER,
	type UnsentAnswer,
} from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type StuckOp, type SyncScheduler } from '../sync/scheduler.js';
import { ConnectButton } from './ConnectButton.js';
import { DetachedSource } from './DetachedSource.js';
import { DisconnectDialog } from './DisconnectDialog.js';
import { type Importing, importItems, ImportNotes, useImportNotes } from './ImportNotes.js';
import { InfoDialog } from './InfoDialog.js';
import { otherLiveSources } from './MoveUnsent.js';
import { OptionsMenu, type OptionsMenuItem } from './OptionsMenu.js';
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

type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

type Sync = Pick<SyncScheduler, 'status' | 'subscribe' | 'syncNow' | 'resync' | 'halt'>;

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
	 * Where the panel's actions go as one `⋯` menu, with what it says above
	 * it: the end of the showing source's row in a compact window's source
	 * dropdown, as every notebook's and note's row ends in its own
	 * (`SourcePanel`, `RowOptions`), with what another source's `⋯` asked of
	 * this one once it is showing. Left out, as at the foot of the sidebar, the
	 * panel is one line — the source and how its syncing is going — with the
	 * actions behind a gear at its end (`StatusLine`), and only what needs the
	 * user said above it, while it does.
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

/**
 * What is not known about the outcome, which differs by what was asked of whom.
 *
 * Everything after the disconnect itself is this device's work
 * (`letGoOfSource`), so a failure of the device half can be one that ran before
 * the server was asked or one that ran after it said yes — the account gone at
 * the provider, its refresh token with it, and this device still bound to it.
 * Saying "the account was not disconnected" there was simply false. With
 * nothing asked of the server there is no such doubt, and the doubt is about
 * this device instead.
 *
 * Trying again is safe from either: a second attempt presents a credential the
 * server has already spent, which comes back `credential_revoked` or
 * `not_found`, and `disconnectAccount` counts both as the disconnect having
 * happened.
 */
const mayHave = (onServer: boolean): string =>
	onServer
		? 'The account may already be disconnected; try again.'
		: 'This device may still be syncing the account; try again.';

/**
 * Why a disconnect did not happen, where it failed rather than being refused.
 *
 * Four answers, because there are four different things it can have been and no
 * two are the same thing to do about. A server that answered with a failure is
 * worth trying again; a server that never answered is worth looking at the
 * connection for; a failure that never left the device is neither, since "stop
 * syncing on this device" asks the server nothing at all and a message about a
 * connection would send the user to the one part that was not used. And a
 * failure from neither call cannot say where it happened, so it does not.
 *
 * Which it was comes from `letGoOfSource`, which knows because it made the call
 * (`errors/reached.ts`), rather than from the shape or the words of the error.
 * What it does *not* know is whether the work landed, so no wording here says.
 */
const failureMessage = (error: unknown, onServer: boolean): string =>
	saying(error, {
		answered: 'The server could not disconnect the account. Try again.',
		unreachable: 'The server cannot be reached, so the account is still connected. Try again.',
		device: `Something on this device went wrong. ${mayHave(onServer)}`,
		unknown: `Something went wrong. ${mayHave(onServer)}`,
	});

/** A time today as a time, and any other as a date. */
const when = (at: number): string => {
	const date = new Date(at);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
		: date.toLocaleDateString();
};

/**
 * From how many a run's count is said. A run of a few — an edit sent, a
 * notebook made — is over before a count could be read, and a bar for each
 * would flash under the line every time the user stopped typing; the runs
 * worth counting are an import's thousand notes, sent from one device and
 * received on another (docs/ARCHITECTURE.md §7, "Sync loop").
 */
export const PROGRESS_FROM = 20;

const counted = (n: number): string => n.toLocaleString();

/**
 * How far a long run has got: a few words for the status line, the sentence
 * for its tooltip and for the panel in a compact window, and how full its bar
 * is — `null` while a scan is still listing, which knows how many so far and
 * not of how many.
 */
interface SyncCount {
	text: string;
	sentence: string;
	bar: { value: number; max: number } | null;
}

/** A long run's count, or nothing for a run too short to count. */
const syncCount = (progress: SyncProgress | undefined, label: string): SyncCount | undefined => {
	if (progress === undefined) return undefined;
	if (progress.stage === 'scanning') return scanCount(progress, label);
	if (progress.total < PROGRESS_FROM) return undefined;
	const of = `${counted(progress.done)} of ${counted(progress.total)}`;
	const bar = { value: progress.done, max: progress.total };
	return progress.stage === 'uploading'
		? { text: `Sending ${of}`, sentence: `Sending changes to ${label}: ${of}.`, bar }
		: { text: `Receiving ${of}`, sentence: `Receiving notes from ${label}: ${of}.`, bar };
};

const scanCount = (
	{ found, done, listing }: Extract<SyncProgress, { stage: 'scanning' }>,
	label: string
): SyncCount | undefined => {
	if (found < PROGRESS_FROM) return undefined;
	if (listing) {
		return {
			text: `Looking for notes: ${counted(found)} found`,
			sentence: `Looking for notes in ${label}: ${counted(found)} found so far.`,
			bar: null,
		};
	}
	const of = `${counted(done)} of ${counted(found)}`;
	return {
		text: `Receiving ${of}`,
		sentence: `Receiving notes from ${label}: ${of}.`,
		bar: { value: done, max: found },
	};
};

/**
 * How full a long run is, under what says how far it has got: a fraction, or,
 * while a scan is still listing, a bar that does not pretend to know.
 */
const SyncBar = ({ count }: { count: SyncCount }) =>
	count.bar === null ? (
		<progress className="account-bar" aria-label="Sync progress" />
	) : (
		<progress
			className="account-bar"
			aria-label="Sync progress"
			value={count.bar.value}
			max={Math.max(count.bar.max, 1)}
		/>
	);

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
			return syncCount(status.progress, label)?.sentence ?? 'Syncing…';
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
	if (status.refusal === 'not_entitled') return `${refusedMessage(status.denial?.code)}.`;
	if (status.refusal === 'not_found') return `The server no longer has this ${label} connection.`;
	if (status.stuck !== undefined) return stuckMessage(status.stuck, label);
	return `Some changes could not be sent to ${label}. They will be tried again (${status.error ?? 'unknown error'}).`;
};

/**
 * How syncing is going, as the status line at the foot of the sidebar says it:
 * a few words after the source's name, with the whole sentence, where there is
 * more to say, as its tooltip. Where syncing has stopped on something the user
 * has to deal with, the line says only that, and the sentence is said above it
 * (`SyncState`), where it stays until it is dealt with.
 */
const lineStatus = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): { text: string; title: string | null } => {
	const said = (words: string, title: string | null = null) => ({
		text: `${label} · ${words}`,
		title,
	});
	switch (status.phase) {
		case 'local':
			return { text: label, title: null };
		case 'syncing':
			return syncingLine(status.progress, label);
		case 'idle':
			return said(statusMessage(status, label, syncable) ?? 'Synced');
		case 'offline':
			return said('Offline', statusMessage(status, label, syncable));
		case 'retrying':
			return said('Trying again shortly', statusMessage(status, label, syncable));
		case 'attention':
			return said('Not syncing');
	}
};

/**
 * A run, in the status line: how far it has got where it is long enough to
 * count, with the sentence and the file it is on in the tooltip.
 */
const syncingLine = (
	progress: SyncProgress | undefined,
	label: string
): { text: string; title: string | null } => {
	const count = syncCount(progress, label);
	if (count === undefined) return { text: `${label} · Syncing…`, title: null };
	return {
		text: `${label} · ${count.text}`,
		title: [count.sentence, progress?.path].filter((line) => line !== undefined).join('\n'),
	};
};

/**
 * What a stuck op was trying to do, in the user's terms. `mkdir` and `rmdir`
 * are about a notebook, and a file's three about a file beside a note (#187):
 * none of them has a note to open.
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
	upload: 'the upload of',
	'move-file': 'the move of the file to',
	'delete-file': 'the deletion of the file',
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
 * (docs/ARCHITECTURE.md §7). Said because nothing else does: such a file is not in the
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

/**
 * What this source's app folder holds that the app cannot see, said where the
 * source is: a user who copies notes into the folder by hand otherwise finds
 * nothing arrived, and nothing to say why (`UNSEEN_AT_PROVIDER`). Shut until
 * asked for, as the devices are: it is the same for every Drive source for
 * good, and open it would be a paragraph in the sidebar for good.
 */
const UnseenAtProvider = ({ provider }: { provider: ProviderKind | undefined }) => {
	const unseen = provider === undefined ? undefined : UNSEEN_AT_PROVIDER[provider];
	if (unseen === undefined) return null;
	return (
		<div className="account-unseen">
			<details>
				<summary className="muted">
					<Icon name="chevron" />
					{unseen.summary}
				</summary>
				<p className="muted">{unseen.detail}</p>
			</details>
		</div>
	);
};

/**
 * The same, from the gear at the foot of the sidebar, where there is no room
 * for it to fold out: an item that opens it over everything.
 */
const unseenItem = (
	provider: ProviderKind | undefined,
	label: string,
	onOpen: () => void
): OptionsMenuItem[] =>
	provider !== undefined && UNSEEN_AT_PROVIDER[provider] !== undefined
		? [{ label: `About ${label}…`, onChoose: onOpen }]
		: [];

const UnseenDialog = ({
	provider,
	onClose,
	returnFocus,
}: {
	provider: ProviderKind | undefined;
	onClose: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}) => {
	const unseen = provider === undefined ? undefined : UNSEEN_AT_PROVIDER[provider];
	if (unseen === undefined) return null;
	return (
		<InfoDialog title={unseen.summary} onClose={onClose} returnFocus={returnFocus}>
			<p>{unseen.detail}</p>
		</InfoDialog>
	);
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
 * The panel's actions as one `⋯` menu, drawn into the end of the showing
 * source's row as every other row's is drawn into its own (`RowOptions`, whose
 * names it takes). There with nothing in it too, disabled, so the rows keep
 * their shape from source to source.
 */
const ActionsMenu = ({ slot, items }: { slot: AccountSlot; items: readonly OptionsMenuItem[] }) => {
	// First, as a notebook's menu has it: what the source is called, then what
	// can be done with it.
	const all =
		slot.onRename === undefined
			? items
			: [{ label: 'Rename', onChoose: slot.onRename }, ...items];
	return slot.menuIn === null
		? null
		: createPortal(
				<OptionsMenu
					label={`Options for “${slot.name}”`}
					title="Source options"
					groupLabel={`Source “${slot.name}”`}
					triggerClassName="icon icon-quiet"
					trigger={<Icon name="overflow" />}
					disabled={all.length === 0}
					items={all}
				/>,
				slot.menuIn
			);
};

/**
 * The foot of the sidebar, once there is nothing to ask the user: the source
 * and how it is going, in one line, and the gear with everything that can be
 * done to it at the line's end. What needs the user — a reconnect, a problem, a
 * question being asked — is drawn above the line while it lasts, so the line
 * is where the panel ends whatever is going on.
 */
const StatusLine = ({
	text,
	title,
	children,
}: {
	text: string;
	title: string | null;
	children: ReactNode;
}) => (
	<div className="account-line">
		<p className="account-status muted" {...(title === null ? {} : { title })}>
			{text}
		</p>
		{children}
	</div>
);

/**
 * The panel's actions, behind a gear at the end of its status line: what the
 * showing source's `⋯` offers in a compact window's source dropdown, from the
 * same lists. It opens upwards, being at the foot of the window.
 */
const GearMenu = ({
	items,
	triggerRef,
}: {
	items: readonly OptionsMenuItem[];
	triggerRef?: RefObject<HTMLButtonElement | null>;
}) => (
	<OptionsMenu
		label="Storage options"
		title="Storage options"
		groupLabel="Storage"
		triggerClassName="icon icon-quiet"
		trigger={<Icon name="gear" />}
		disabled={items.length === 0}
		items={items}
		rises
		{...(triggerRef === undefined ? {} : { triggerRef })}
	/>
);

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
		? [{ label: 'Download all notes', onChoose: downloading.start, disabled: downloading.busy }]
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
		label: 'this device',
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
	const items = [...downloadItem(holds, downloading), ...importItems(importing)];

	return (
		<section className="account" aria-label="Storage">
			{/* Said by the status line, at the foot of the sidebar, with the way
			    to connect beside it in the bar above, in words while nothing is
			    connected. In a compact window's source dropdown the way is the
			    `+` in its header, which never has words. */}
			{slot !== undefined && (
				<p className="muted">
					Notes are kept on this device only.
					{offerable.length > 0 && ' Use + above to connect storage.'}
				</p>
			)}
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
				<p className="muted">
					This browser may clear them without warning. To keep them, connect storage or
					download them.
				</p>
			)}
			<DownloadAll holds={holds} downloading={downloading} />
			<ImportNotes importing={importing} />
			{slot === undefined ? (
				<StatusLine text="On this device only" title={null}>
					<GearMenu items={items} />
				</StatusLine>
			) : (
				<ActionsMenu slot={slot} items={items} />
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

/**
 * Under "this account cannot sync on this server": the operator's own words
 * for why, as the server passed them on with its refusal, and the one thing
 * their gate offers to do about it. Nothing when there is neither — the line
 * above is then the whole of what is known.
 */
const Denied = ({
	status,
	syncable,
	config,
}: {
	status: SchedulerStatus;
	/** Said only where the line above it is (`attentionMessage`). */
	syncable: boolean;
	config: Asked<InstanceConfig>;
}) => {
	if (!syncable || status.phase !== 'attention' || status.refusal !== 'not_entitled') return null;
	const reason = status.denial?.reason;
	const gate = answer(config)?.connectGate;
	if (reason === undefined && gate === undefined) return null;
	return (
		<p className="muted">
			{reason}
			{reason !== undefined && gate !== undefined && ' '}
			{gate !== undefined && (
				// In this window, as the `+` menu's is (`GateLink`).
				<a href={gate.action.url} rel="noreferrer">
					{gate.action.label}
				</a>
			)}
		</p>
	);
};

/** A source the app can sync, and so re-scan: one at a provider it can still connect. */
const isSyncable = (bound: SyncStateRecord): boolean =>
	bound.provider !== undefined && CONNECTABLE.includes(bound.provider);

/**
 * A source's first import, which holds the app behind its own dialog
 * (`ImportDialog`): the panel offers nothing about syncing until it is done.
 */
const importingHere = (bound: SyncStateRecord): boolean => bound.importing !== undefined;

interface SyncStateProps {
	client: Client;
	database: NotesDatabase;
	sync: Sync;
	bound: SyncStateRecord;
	label: string;
	/** This server lets the user connect storage from here. */
	reconnectable: boolean;
	/** What this server offers, which includes what its operator says to an account it will not sync. */
	config: Asked<InstanceConfig>;
	returnTo: string;
	navigate?: (url: string) => void;
	/** Whether the re-scan is being asked about, which the panel holds. */
	rescanning: boolean;
	onRescanning: (asking: boolean) => void;
	/**
	 * Whether the panel ends in a status line (`StatusLine`), which says how
	 * syncing is going itself: here, then, only where it has stopped on
	 * something the user has to deal with.
	 */
	line: boolean;
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
	config,
	returnTo,
	navigate,
	rescanning,
	onRescanning: setRescanning,
	line,
}: SyncStateProps) => {
	const status = useSyncStatus(sync);
	const syncable = isSyncable(bound);
	const message = statusMessage(status, label, syncable);
	const count = syncCount(status.progress, label);
	const reconnect = needsReconnect(status);

	return (
		<>
			{/* Said even where there is no link to offer: sync has stopped. */}
			{reconnect && (
				<p className="muted">
					{status.refusal === 'credential_revoked' ||
					status.refusal === 'credential_required'
						? `This device can no longer reach ${label}.`
						: `${label} needs to be connected again.`}
				</p>
			)}
			{/*
			 * A button of the panel's, under what it answers, rather than a word
			 * in the sentence: it was one, dressed as nothing, that a phone's
			 * taller button wrapped onto the line under the text with no space
			 * between them. And what it renders besides — its own error, the
			 * question about the device's notes — is not something a paragraph
			 * may hold.
			 */}
			{reconnect && reconnectable && bound.provider !== undefined && (
				<ConnectButton
					db={database}
					client={client}
					provider={bound.provider}
					returnTo={returnTo}
					{...(navigate === undefined ? {} : { navigate })}
				>
					Connect again
				</ConnectButton>
			)}
			{message !== null && (!line || status.phase === 'attention') && (
				<p className="muted">{message}</p>
			)}
			{!line && count !== undefined && <SyncBar count={count} />}
			<Denied status={status} syncable={syncable} config={config} />
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
			{/*
			 * The way out of a cursor the provider has lost track of, or a
			 * store that disagrees with the remote about what is there. It is
			 * not a repair of nothing: the confirm says what it costs. Asked for
			 * from the gear's menu, or the `⋯`.
			 */}
			{status.phase !== 'local' && syncable && rescanning && (
				<div className="account-confirm">
					<p className="muted">
						Read everything in {label} again? This device compares every note with the
						folder from scratch. Notes that are no longer in {label} are removed here
						too, unless they have edits that have not been sent.
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
			)}
		</>
	);
};

/**
 * The devices holding a source's connection, as the server lists them. The
 * device list shows them; the disconnect question counts them, since what it
 * does depends on whether this is the last.
 */
const useGrants = (client: Client, database: NotesDatabase, connectionId: string) => {
	const [grants, setGrants] = useState<Asked<Grant[]>>({ kind: 'asking' });

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

	return { grants, ask };
};

/**
 * How many other devices a disconnect here would leave connected, or
 * `undefined` where the server has not said. One signed out for being idle is
 * not counted: the server does not count it either, and disconnecting the last
 * live device takes the account with it (`signOut`).
 */
const stillSignedIn = (grants: Asked<Grant[]>): number | undefined =>
	answer(grants)?.filter((grant) => !grant.current && !grant.expired).length;

const devicesLine = (count: number): string =>
	`${count === 1 ? '1 other device' : `${String(count)} other devices`} signed in on this account`;

/** Taking a device off the connection, and what went wrong if it did not come off. */
const useRevoke = (
	client: Client,
	database: NotesDatabase,
	connectionId: string,
	onChanged: () => void
) => {
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const revoke = (grantId: string) => {
		setBusy(grantId);
		setProblem(null);
		// Each half labelled as it is called: the credential is read from this
		// device and the grant is revoked on the server, and a failure of the
		// first has nothing to do with a connection. The device half runs strictly
		// before the server is asked, which is what lets its wording say that
		// nothing was removed.
		void failedAt('device', () => withHeld(database, client, connectionId))
			.then((authed) =>
				authed === undefined
					? undefined
					: failedAt('server', () => authed.revokeGrant(grantId))
			)
			.then((result) => {
				if (result?.ok === true) {
					onChanged();
					return;
				}
				setProblem('That device is still signed in: the server would not remove it.');
			})
			.catch((error: unknown) => {
				setProblem(
					saying(error, {
						answered: 'The server could not remove that device. Try again.',
						unreachable:
							'The server cannot be reached, so nothing was removed. Try again.',
						device: 'Something on this device went wrong, so nothing was removed. Try again.',
						// Neither call, so it happened after the revoke had already
						// done whatever it did.
						unknown:
							'Something went wrong. That device may already have been removed; try again.',
					})
				);
			})
			.finally(() => {
				setBusy(null);
			});
	};
	return { busy, problem, revoke };
};

/** A row per other device, each with its Remove, and what went wrong with one. */
const DeviceRows = ({
	others,
	revoking,
}: {
	others: readonly Grant[];
	revoking: ReturnType<typeof useRevoke>;
}) => (
	<>
		<ul aria-label="Other devices">
			{others.map((grant) => (
				<li key={grant.id}>
					<span className="muted">
						{`${grant.device ?? 'A device'}, last used ${when(grant.lastUsedAt)}`}
						{grant.expired && ' · signed out for being idle'}
					</span>
					<button
						type="button"
						disabled={revoking.busy !== null}
						onClick={() => {
							revoking.revoke(grant.id);
						}}
					>
						Remove
					</button>
				</li>
			))}
		</ul>
		{revoking.problem !== null && (
			<p className="muted" role="alert">
				{revoking.problem}
			</p>
		)}
	</>
);

/**
 * The devices holding this connection, and the way to take one away.
 *
 * The point of it is that a stolen credential is visible and revocable. It is
 * the compensating control for holding a bearer in IndexedDB, where `httpOnly`
 * cannot protect it (docs/ARCHITECTURE.md §6), so it is asked for on open, and
 * how many other devices there are is said whether or not the list is open:
 * one more than the user has is what a theft looks like from here. The rows
 * fold behind that count (2026-10-02), each naming the device as its browser
 * did at sign-in ("Safari on iPhone"), since a row that says only "a device"
 * cannot be told from the one in the user's pocket. This one is not among
 * them.
 *
 * Revoking is permanent in a way worth saying: the server spends a credential's
 * hash for ever, so the device that held it cannot be talked back into this
 * connection — it has to be connected again from scratch.
 */
const Devices = ({
	client,
	database,
	connectionId,
	grants,
	onChanged,
	line,
	gear,
}: {
	client: Client;
	database: NotesDatabase;
	/**
	 * Which source these are the devices of. Named rather than looked up: it
	 * pins every call in this component to one source, rather than re-reading
	 * "whichever is in front" between asking and revoking.
	 */
	connectionId: string;
	/**
	 * Asked by the panel (`useGrants`), keyed by the same source, which is what
	 * keeps the list from staying on the previous source's devices after a
	 * switch, with a Remove sending a grant id the new connection has never
	 * heard of. The panel's because the disconnect question counts them too.
	 */
	grants: Asked<Grant[]>;
	/** A device was removed: ask again. */
	onChanged: () => void;
	/**
	 * In the status line at the foot of the sidebar (`StatusLine`), where there
	 * is room for the count and not for the rows: the count is a button, beside
	 * the gear, that opens them over everything. Still said without opening
	 * anything, since the count is what the list is for.
	 */
	line: boolean;
	/**
	 * Where the focus goes when the list is put away with nobody left on it: the
	 * count it was opened from went with the last of them.
	 */
	gear?: RefObject<HTMLButtonElement | null>;
}) => {
	const revoking = useRevoke(client, database, connectionId, onChanged);
	const [open, setOpen] = useState(false);
	const count = useRef<HTMLButtonElement>(null);

	// This one is not listed: it cannot be removed from itself (disconnecting
	// is that), and "this device" is the one thing about it the user knows.
	const others = (answer(grants) ?? []).filter((grant) => !grant.current);
	// Kept open after the last other device is removed, saying so, rather than
	// taken away from under the focus.
	if (others.length === 0 && !open) return null;

	if (line) {
		return (
			<>
				{others.length > 0 && (
					<button
						ref={count}
						type="button"
						className="icon icon-quiet account-devices-count"
						aria-label={devicesLine(others.length)}
						title={devicesLine(others.length)}
						onClick={() => {
							setOpen(true);
						}}
					>
						<Icon name="device" />
						<span aria-hidden="true">{others.length}</span>
					</button>
				)}
				{open && (
					<InfoDialog
						title="Other devices signed in on this account"
						onClose={() => {
							setOpen(false);
							if (others.length === 0) gear?.current?.focus();
						}}
						returnFocus={count}
					>
						<div className="account-devices">
							{others.length === 0 ? (
								<p>No other device is signed in on this account.</p>
							) : (
								<DeviceRows others={others} revoking={revoking} />
							)}
						</div>
					</InfoDialog>
				)}
			</>
		);
	}

	return (
		<div className="account-devices">
			{/* Shut until asked for: it is there to check now and then, and open
			    it is a row per device under everything the panel says. */}
			<details>
				<summary className="muted">
					<Icon name="chevron" />
					{devicesLine(others.length)}
				</summary>
				<DeviceRows others={others} revoking={revoking} />
			</details>
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
 * How long the last push before a disconnect is given, before the user is asked
 * anyway.
 *
 * A push still going is not cancelled — whatever it lands is one less thing on
 * the list — but nobody is kept waiting on a provider that is not answering,
 * and the question is the same either way: what is left when it stops.
 */
const LAST_PUSH_MS = 10_000;

const after = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Everything the dialog before a disconnect is about, gathered in the order it
 * has to be gathered in.
 *
 * The editors write first, because text inside the autosave window is in no row
 * and a list taken from the store alone would leave out the sentence just
 * typed. Then, where there is any prospect of it working, one last push: the
 * best answer to "this has not been sent" is to send it. Only then is the list
 * made, and with it the record of what the user is being shown — which is all a
 * discard may ever reach (`seenIn`).
 *
 * The notebooks the source has are part of that record even where they are not
 * listed as unsent. Letting the source go removes the sent notes that are the
 * proof a notebook was made, so a notebook that had nothing done to it reads as
 * unsent afterwards, and would otherwise look like something written since.
 */
const prepare = async (
	database: NotesDatabase,
	connectionId: string,
	push: (() => Promise<void>) | undefined
): Promise<{ listed: Unsynced; seen: Seen; failing: boolean }> => {
	const settled = await settleEditors();
	if (push !== undefined) {
		await Promise.race([push().catch(() => undefined), after(LAST_PUSH_MS)]);
	}
	const listed = await unsyncedIn(database, connectionId);
	const standing = (
		await database.folders.where('connectionId').equals(connectionId).toArray()
	).map((folder) => folder.path);
	return { listed, seen: seenIn(listed, standing), failing: holdsTextFor(settled, connectionId) };
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
 * What is left to say once a source has been let go — or has not been.
 *
 * `released` is the whole of what was asked for, and says nothing. The other
 * three each mean the user's answer was not carried out in full, and each names
 * something that happened while they were deciding, so none of them is a
 * failure to report as one: nothing was lost in any of them.
 */
const wentAs = (result: LetGoResult): Disconnecting | undefined => {
	if (!result.ok) {
		return { busy: false, problem: refusalMessage(result.refusal), stranded: true };
	}
	const said = (problem: string): Disconnecting => ({ busy: false, problem, stranded: false });
	switch (result.outcome) {
		case 'released':
			return undefined;
		case 'detached':
			return said(
				'Something was written in this source after the list was shown. It was not on the list, so it has been kept.'
			);
		case 'holding':
			return said(
				'A note here has text that could not be saved, so the note and this source have been kept rather than removed with it. Open the note and copy the text somewhere safe; the note says how.'
			);
		case 'reconnected':
			return said('This source was connected again meanwhile. Nothing has been changed.');
		case 'no-target':
			return said('That source is not connected any more, so nothing was moved.');
		case 'unverified':
			return said(
				'This source has not been checked against its account yet, so what it holds could not be told apart from work that was never sent. Nothing was moved.'
			);
		case 'nothing-to-move':
			return said('There was nothing here to move, so nothing was moved.');
	}
};

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
		(connectionId: string, answer: Omit<LetGoInput, 'connectionId'>): Promise<void> => {
			if (pending.current.has(connectionId)) return Promise.resolve();
			pending.current.add(connectionId);
			put(connectionId, { busy: true, problem: null, stranded: false });
			return letGoOfSource(database, client, { connectionId, ...answer })
				.then((result) => {
					put(connectionId, wentAs(result));
				})
				.catch((error: unknown) => {
					put(connectionId, {
						busy: false,
						// What was asked of whom, which is what decides which outcome
						// the message may leave open.
						problem: failureMessage(error, answer.onServer),
						stranded: true,
					});
				})
				.finally(() => {
					pending.current.delete(connectionId);
				});
		},
		[client, database, put]
	);

	return { disconnects, disconnect };
};

/**
 * Whether one last push before the question is worth waiting for. Not where the
 * scheduler is not syncing this source anyway, not where it has already stopped
 * on something it will stop on again, and not where there is no network: each
 * of those is a delay in front of the same question.
 */
const worthPushing = (status: SchedulerStatus): boolean =>
	navigator.onLine &&
	status.phase !== 'local' &&
	status.phase !== 'attention' &&
	status.phase !== 'offline';

/**
 * Why the last push could not clear what is here, where the user would do
 * better to cancel and come back to it. Not a reason to refuse the disconnect:
 * they may have no intention of ever reaching this account again.
 */
const stoppedBy = (status: SchedulerStatus, listed: Unsynced): 'offline' | 'blocked' | null => {
	if (status.phase === 'offline' || !navigator.onLine) return 'offline';
	return listed.blocked ? 'blocked' : null;
};

/**
 * What can be done to a connected source, beyond what its status offers: the
 * items of the gear's menu at the foot of the sidebar, or of the `⋯` in a
 * compact window's source dropdown, disabled where they cannot be done now.
 * Neither way to let the source go while the disconnect question is open,
 * which is the way on from there.
 */
const storageItems = ({
	bound,
	phase,
	rescanning,
	onRescan,
	download,
	imports,
	about,
	stranded,
	open,
	disconnectBlocked,
	syncNow,
	ask,
}: {
	bound: SyncStateRecord;
	phase: SchedulerStatus['phase'];
	rescanning: boolean;
	onRescan: () => void;
	download: readonly OptionsMenuItem[];
	/** The ways to import (`importItems`), or none where an import is held back. */
	imports: readonly OptionsMenuItem[];
	/** What the provider keeps from the app, where it is asked for from the gear. */
	about: readonly OptionsMenuItem[];
	stranded: boolean;
	/** Whether the disconnect question is open. */
	open: boolean;
	disconnectBlocked: boolean;
	syncNow: () => void;
	ask: (onServer: boolean) => void;
}): OptionsMenuItem[] => {
	const syncing = phase === 'syncing';
	const syncs = !importingHere(bound) && phase !== 'local';
	return [
		...(syncs ? [{ label: 'Sync now', onChoose: syncNow, disabled: syncing }] : []),
		...(syncs && isSyncable(bound) && !rescanning
			? [{ label: 'Re-scan from scratch', onChoose: onRescan, disabled: syncing }]
			: []),
		...download,
		...imports,
		...about,
		...(stranded && !open
			? [
					{
						label: 'Stop syncing on this device',
						// The same question again, and nothing asked of the server:
						// it has already refused, and nothing on it is touched.
						onChoose: () => {
							ask(false);
						},
					},
				]
			: []),
		...(open
			? []
			: [
					{
						label: 'Disconnect…',
						onChoose: () => {
							ask(true);
						},
						danger: true,
						disabled: disconnectBlocked,
					},
				]),
	];
};

/**
 * Which source this is and whose, at the top of its panel in a compact
 * window's source dropdown. Nothing at the foot of the sidebar, whose status
 * line names the source, with the account in its tooltip.
 */
const SourceHeading = ({
	line,
	label,
	displayName,
}: {
	line: boolean;
	label: string;
	displayName: string | null;
}) =>
	line ? null : (
		<p>
			Syncing with {label}
			{displayName !== null && <span className="muted"> · {displayName}</span>}
		</p>
	);

/**
 * Where a connected source's panel ends. In a compact window's source dropdown
 * that is the `⋯` at the end of the source's row. At the foot of the sidebar it
 * is the status line (`StatusLine`): how syncing is going, the count of the
 * other devices, and the gear, whose menu also opens what the provider keeps
 * from the app — said there over everything, the line having no room for it.
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
	...actions
}: Omit<Parameters<typeof storageItems>[0], 'about' | 'phase' | 'download' | 'imports'> & {
	slot: AccountSlot | undefined;
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
	/** The gear, where the focus goes back to once a question is put away. */
	openButton: RefObject<HTMLButtonElement | null>;
	client: Client;
	database: NotesDatabase;
	grants: Asked<Grant[]>;
	onGrantsChanged: () => void;
}) => {
	const [about, setAbout] = useState(false);
	const items = storageItems({
		...actions,
		bound,
		phase: status.phase,
		download: downloadable ? downloadItem(holds, downloading) : [],
		imports: downloadable ? importItems(importing) : [],
		about:
			slot === undefined
				? unseenItem(bound.provider, label, () => {
						setAbout(true);
					})
				: [],
	});
	if (slot !== undefined) return <ActionsMenu slot={slot} items={items} />;
	const said = lineStatus(status, label, isSyncable(bound));
	const count = syncCount(status.progress, label);
	// Who the account is, which the line has no room for, and the whole of
	// what it says about syncing, where that is more than its few words.
	const title = [
		`Syncing with ${label}${displayName === null ? '' : ` · ${displayName}`}`,
		said.title,
	]
		.filter((line) => line !== null)
		.join('\n');
	return (
		<>
			{about && (
				<UnseenDialog
					provider={bound.provider}
					onClose={() => {
						setAbout(false);
					}}
					returnFocus={openButton}
				/>
			)}
			<StatusLine text={said.text} title={title}>
				<Devices
					client={client}
					database={database}
					connectionId={bound.connectionId}
					grants={grants}
					onChanged={onGrantsChanged}
					line
					gear={openButton}
				/>
				<GearMenu items={items} triggerRef={openButton} />
			</StatusLine>
			{count !== undefined && <SyncBar count={count} />}
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
	label: bound.provider === undefined ? 'storage' : PROVIDER_LABELS[bound.provider],
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
	// Ends in a status line, at the foot of the sidebar, rather than in a
	// compact window's source dropdown.
	const line = slot === undefined;
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
	// Focus follows the step the user is on, rather than falling to the page
	// when the button they pressed goes away. Not on first render.
	const focusNext = useRef<'cancel' | 'open' | null>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const openButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	// Which question the answer coming back belongs to (`ask`).
	const asking = useRef(0);
	const open = step.kind !== 'closed';
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
	}, [step.kind]);
	const cancel = useCallback(() => {
		// A question nobody is waiting for the answer to: whatever the last push
		// is doing, it can go on doing.
		asking.current += 1;
		focusNext.current = 'open';
		setStep({ kind: 'closed' });
	}, []);
	useEscape(panel, open, cancel);

	const label = bound.provider === undefined ? 'storage' : PROVIDER_LABELS[bound.provider];
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
		focusNext.current = 'cancel';
		setTrouble(null);
		setStep({ kind: 'pushing', onServer });
		// Again, for the question's sake: whether this is the last device decides
		// what it says, and a device may have joined since the panel opened.
		if (onServer) devices.ask();
		void prepare(database, connectionId, pushable ? () => sync.syncNow() : undefined)
			.then((ready) => {
				if (asking.current !== mine) return;
				// Again: the Cancel the focus was on belonged to the step that is
				// about to go, and the question is the one that has to be answered
				// safely by a stray Enter.
				focusNext.current = 'cancel';
				setStep({ kind: 'asking', onServer, ...ready });
			})
			.catch(() => {
				if (asking.current !== mine) return;
				setStep({ kind: 'closed' });
				setTrouble(
					'What is on this device could not be read, so nothing was disconnected.'
				);
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
		if (open) return true;
		if (disconnectBlocked) return false;
		ask(true);
		return true;
	});

	return (
		<section ref={panel} className="account" aria-label="Storage">
			<SourceHeading line={line} label={label} displayName={displayName} />
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
				line={line}
			/>
			{!line && <UnseenAtProvider provider={bound.provider} />}
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
			{!line && (
				<Devices
					client={client}
					database={database}
					connectionId={connectionId}
					grants={devices.grants}
					onChanged={devices.ask}
					line={false}
				/>
			)}
			{(problem ?? trouble) !== null && (
				<p className="muted" role="alert">
					{problem ?? trouble}
				</p>
			)}
			{step.kind === 'pushing' && (
				<div
					className="account-confirm"
					role="group"
					aria-label="Sending your last changes"
				>
					<p className="muted">Sending your last changes…</p>
					<button ref={cancelButton} type="button" className="ghost" onClick={cancel}>
						Cancel
					</button>
				</div>
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
					cancelRef={cancelButton}
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
				ask={ask}
				openButton={openButton}
				client={client}
				database={database}
				grants={devices.grants}
				onGrantsChanged={devices.ask}
			/>
		</section>
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
							Reconnect
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

		if (bound.state.detached !== undefined) {
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
