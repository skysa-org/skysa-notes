import {
	basename,
	type ConnectGate,
	type EntitlementCode,
	isWithin,
	parentPath,
	rebasePath,
	ROOT,
} from '@skysa/core';
import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api/client.js';
import { answer, useInstanceConfig } from '../api/instanceConfig.js';
import { parseChord } from '../commands/chord.js';
import { CommandsProvider, useCommand, useShortcuts } from '../commands/context.js';
import { AccountPanel, returnPath } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { CompactBar, type Pane, useCompactLayout } from '../components/CompactBar.js';
import { DeletedNotice } from '../components/DeletedNotice.js';
import { ErrorScreen } from '../components/ErrorScreen.js';
import { HeldImport } from '../components/ImportProgress.js';
import { NoteList } from '../components/NoteList.js';
import { noteMenuItems } from '../components/noteMenu.js';
import {
	type DisplacedText,
	type NoteDraft,
	NoteView,
	type NoteViewHandle,
} from '../components/NoteView.js';
import { SearchField } from '../components/SearchField.js';
import { Sidebar } from '../components/Sidebar.js';
import { SourcePanel, SourceTabs } from '../components/SourceTabs.js';
import { Toast, type ToastAction, type ToastTone } from '../components/Toast.js';
import { InstallBanner } from '../install/InstallBanner.js';
import { TakeShare } from '../share/TakeShare.js';
import {
	connectCodeAskedAt,
	dropConnectCode,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
} from '../store/connectCode.js';
import { showConnection } from '../store/connection.js';
import {
	activeConnectionId,
	db,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	noteRef,
	type SyncStateRecord,
} from '../store/db.js';
import { downloadNotice, downloadProblem, downloadSource } from '../store/exportNotes.js';
import {
	createFolder,
	deleteFolder,
	FolderExistsError,
	moveFolder,
	renameFolder,
} from '../store/folders.js';
import { settleEditors } from '../store/heldEdits.js';
import {
	type NoteToOpen,
	useActiveConnectionId,
	useActiveSource,
	useClaimingConnection,
	useHeldImport,
	useHoldsAnything,
	useLastOpen,
	useLooseNoteCount,
	useNote,
	useNoteSearch,
	useNotesInFolder,
	useNoteToOpen,
	useOpenNotebooks,
	usePinnedTree,
	useSources,
} from '../store/hooks.js';
import { keeping } from '../store/keeping.js';
import { type LastOpen, noteIsUnder, pickNote, rememberOpen } from '../store/lastOpen.js';
import { createLiveEdits } from '../store/liveEdits.js';
import {
	createNote,
	draftNote,
	moveNote,
	saveNoteBody,
	setNoteEditorMode,
	undeleteNote,
} from '../store/notes.js';
import { setNotebooksOpen } from '../store/openNotebooks.js';
import { pinnedFirst, type Pins, setNotebookPinned, setNotePinned } from '../store/pins.js';
import { dropMove, type Moving } from '../store/rearrange.js';
import { createRenamings, type Renamings } from '../store/renaming.js';
import { findFolder, type FolderNode, selectedFolderPath } from '../store/tree.js';
import { PROVIDER_LABELS, refusedMessage, sourceName, tabName } from '../sync/account.js';
import {
	type AppSearch,
	type ConnectOutcome,
	folderFromSearch,
	folderToSearch,
	parseSearch,
} from './search.js';

/**
 * The app. Which folder and note are open lives in the URL rather than in
 * component state, so reloading or following a link lands the user where it
 * says; and on the device (`store/lastOpen.ts`), so reopening the PWA at its
 * start URL, or showing a source again, lands them where they were.
 */

/**
 * Something to say to the user, and what kind of thing it is. The tone is
 * settled where the words are: only here is it known whether "it is back, but
 * somewhere else" is good news or a warning.
 */
interface Notice {
	readonly message: string;
	readonly tone: ToastTone;
	/** Somewhere to go about it, when there is somewhere. */
	readonly action?: ToastAction | undefined;
}

/**
 * What to tell the user on the way back from connecting a storage account, or
 * `undefined` for a value this build has no message for.
 *
 * The `default` is what stopped an **empty** alert banner — a red bar saying
 * nothing — when a hand-typed or bookmarked `?connect=signin` arrived here
 * intact, returning `undefined` through a `string` signature. It arrived
 * because `parseSearch` left a refused key out instead of overriding it, and
 * the router's spread put the raw one back (see `parseSearch`). That is fixed
 * there; this stays, because a build older than the API it talks to can still
 * be sent an outcome it has no words for.
 *
 * Found on 2026-09-18 by removing `signin`, `conflict` and `occupied` — the
 * three outcomes Phase 7 retired server-side — which is when a value outside
 * the union first became reachable.
 *
 * `codeRefused` is a plain no to a connect that carried the gate's code
 * (`codeWasRefused`), which is said to be about the code.
 */
const connectMessage = (
	outcome: ConnectOutcome,
	code?: EntitlementCode,
	gate?: ConnectGate,
	codeRefused = false
): Notice | undefined => {
	switch (outcome) {
		case 'ok':
			return { message: 'Storage connected. Your notes will sync with it.', tone: 'success' };
		// The user's own choice, and nothing is broken — but nothing is
		// connected either, which is not what they will assume from a screen
		// that looks the same as before they started.
		case 'denied':
			return { message: 'Connecting storage was cancelled.', tone: 'warning' };
		case 'failed':
			return {
				message: 'The storage account could not be connected. Try again.',
				tone: 'error',
			};
		// A warning rather than an error: this one worked exactly as it was
		// asked to, and what to do about it is a tickbox away.
		case 'partial':
			return {
				message:
					'Access to your files was not granted, so storage was not connected. Connect again and leave that permission ticked.',
				tone: 'warning',
			};
		// Trying again will not help: this server will not have the account.
		// What might is whatever its operator offers instead, when they do.
		case 'refused':
			return {
				message: `${codeRefused ? 'The code you entered was not accepted or has expired' : refusedMessage(code)}, so storage was not connected.`,
				tone: 'error',
				action: gate?.action,
			};
		// The browser came back from the provider with no flow of its own for the
		// server to finish: one that took too long, or a callback opened again
		// long after it was answered. Whether anything was connected by then is
		// not known there, and the storage tabs already say, so it is not guessed.
		case 'expired':
			return {
				message:
					'Connecting storage did not finish. If it is not connected, connect it again.',
				tone: 'warning',
			};
		default:
			return undefined;
	}
};

/**
 * The shell's chords. `Mod` is Cmd or Ctrl, whichever the keyboard has, and
 * every one of these is printed in the palette from this same value — the
 * shortcut and its label cannot drift apart because there is only one of them.
 */
const PALETTE = parseChord('Mod+K');
/**
 * A bare key, because in a browser there is nothing else left. `Mod+N` opens a
 * window and `Mod+Shift+N` a private one, in Chrome, Edge and Safari alike, and
 * the page is never asked: printing either in the palette would advertise a
 * shortcut that cannot fire, which is the drift this registry exists to stop.
 *
 * Bare keys are the reason `reachable` is there: this one is ignored while the
 * user is in a field or an editor, which is where an `n` means the letter.
 */
const NEW_NOTE = parseChord('n');
const FIND = parseChord('Mod+Shift+F');

/**
 * What the source dropdown opens, in a compact window only: the sources, the
 * way to another account, and the storage panel a wide window keeps under the
 * notebooks, with its actions in the dropdown's `⋯`.
 */
const SourceDropdown = ({
	compact,
	returnTo,
	onChosen,
	renamings,
	enterCode,
}: {
	compact: boolean;
	returnTo: string;
	onChosen: () => void;
	renamings: Renamings;
	enterCode: number;
}) =>
	compact ? (
		<SourcePanel
			returnTo={returnTo}
			renamings={renamings}
			enterCode={enterCode}
			account={(slot) => <AccountPanel slot={slot} />}
			onChosen={onChosen}
		/>
	) : null;

/**
 * `?enter=code`, from an operator's page once the user has a code: the way to
 * connect storage, opened at the gate's code field. Counted, so that each
 * arrival opens it once (`useAdding` in `SourceTabs.tsx`), and taken out of
 * the URL at once, so that a reload does not open it again. In a compact
 * window the `+` is in the sources dropdown, which opens first.
 */
const useEnterCode = (
	enter: AppSearch['enter'],
	compact: boolean,
	setPanel: (pane: Pane | null) => void
): number => {
	const navigate = useNavigate({ from: Route.fullPath });
	const [asked, setAsked] = useState(0);
	// Counted in render, as React has state follow a prop: the URL arriving
	// with it is the change, and the effect below takes it out again.
	const [seen, setSeen] = useState<AppSearch['enter']>();
	if (enter !== seen) {
		setSeen(enter);
		if (enter !== undefined) setAsked(asked + 1);
	}
	useEffect(() => {
		if (enter === undefined) return;
		if (compact) setPanel('sources');
		void navigate({ search: ({ enter: _enter, ...rest }) => rest, replace: true });
	}, [enter, compact, setPanel, navigate]);
	return asked;
};

/**
 * Picking the open note up to move it, from the palette — offered only while
 * nothing else is in the air. The note's menu offers it through `menuFor`, as
 * a right-click on its row does.
 */
const useNoteMove = (
	openNote: NoteRecord | undefined,
	moving: Moving | null,
	pickUp: (what: Moving) => void
): void => {
	const offered = openNote !== undefined && moving === null;
	const move = () => {
		if (openNote === undefined) return;
		pickUp({ kind: 'note', id: openNote.id, path: openNote.path, name: openNote.title });
	};

	useCommand({
		id: 'note.move',
		label: 'Move note to notebook',
		group: 'Note',
		enabled: offered,
		run: move,
	});
};

/**
 * The source showing, whole, as an archive of markdown (docs/ARCHITECTURE.md
 * §7, "Getting a library out"). For a device with nothing connected it is the
 * one copy of the notes that can leave this browser; for a source that syncs it
 * is what this device holds of its folder, without a trip to the provider's
 * own client. Unavailable while the source holds nothing, which would be an
 * empty archive, and while a source's first import is still filling it,
 * which would be whatever part had arrived under a name that says "all" — the
 * storage panel holds its button back then too.
 */
const useDownloadCommand = ({
	connectionId,
	source,
	onProblem,
}: {
	connectionId: string | undefined;
	/** The source showing: `null` for the device's own, `undefined` until read. */
	source: SyncStateRecord | null | undefined;
	onProblem: (notice: Notice) => void;
}) => {
	const holds = useHoldsAnything(connectionId);
	useCommand({
		id: 'app.download',
		label: 'Download all notes',
		group: 'App',
		enabled: connectionId !== undefined && source?.importing === undefined && holds === true,
		run: () => {
			if (connectionId === undefined) return;
			void downloadSource(db, connectionId)
				.then((answer) => {
					const notice = downloadNotice(answer);
					if (notice !== null) onProblem({ message: notice, tone: 'warning' });
				})
				.catch((error: unknown) => {
					onProblem({ message: downloadProblem(error), tone: 'error' });
				});
		},
	});
};

/**
 * Installing the app is one of the things Chromium weighs when it decides
 * whether to keep a site's storage, so the question is put again then,
 * whatever it said before (`store/keeping.ts`). Silent there; the event is
 * Chromium's alone.
 */
const useKeepOnInstall = () => {
	useEffect(() => {
		const installed = () => {
			void keeping.ask(db, 'installed');
		};
		window.addEventListener('appinstalled', installed);
		return () => {
			window.removeEventListener('appinstalled', installed);
		};
	}, []);
};

/**
 * What the empty note pane offers to make. A note where there is a notebook to
 * put it in, as `note.new` has; and the first notebook while there is none,
 * since in a compact window this pane is the only one on screen.
 */
const emptyPaneOffers = ({
	folder,
	nothingYet,
	onCreateNote,
	onCreateNotebook,
}: {
	folder: string | undefined;
	nothingYet: boolean;
	onCreateNote: () => void;
	onCreateNotebook: () => void;
}): { onCreateNote?: () => void; onCreateNotebook?: () => void } => {
	if (folder !== undefined && folder !== ROOT) return { onCreateNote };
	return nothingYet ? { onCreateNotebook } : {};
};

/**
 * Whether a refusal is the operator's policy turning down the code typed into
 * its gate (`ConnectGate.connectCode`): a plain no — `not_allowed`, or no code
 * at all — to a connect made while this tab held one. The code is what the
 * person offered, and what they can put right. A `lapsed` or a `limit_reached`
 * is about the account or the instance, whatever was typed, and is said as it
 * is.
 *
 * Not a value the policy gave to hold in a code's place: nothing was typed
 * this time, and a pass that cost an email to get is not thrown away on a no
 * that may be about the account. The policy is asked about it instead
 * (`useCodeAskedAgain`), and lets it go if it no longer takes it.
 */
const codeWasRefused = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined
): boolean =>
	connect === 'refused' &&
	(code === undefined || code === 'not_allowed') &&
	heldConnectCode() !== undefined &&
	heldConnectCodeShown();

/** How long the policy's word on a held value stands before the app asks again as it loads. */
const ASK_AGAIN_MS = 60 * 60_000;

/**
 * What the operator's policy gave to hold in place of the gate's code
 * (`ConnectCodeCheck.hold`), asked about again once as the app loads, where
 * the instance's gate asks for a code: at most once an hour, since the policy
 * last answered, and at once after a refused connect.
 *
 * A typed code is not asked about again: it is good for as long as the policy
 * said when it took it, minutes as a rule, and an answer would add nothing.
 * Nor is a held value the policy answered about within the hour. Each asking
 * costs one of the guesses the instance allows an address
 * (`connect-code:<ip>`), which the people behind one carrier's or one office's
 * address share, and someone typing a fresh code must not find them spent by
 * the others opening the app.
 *
 * A policy that hands a device a pass to keep says each time whether it still
 * takes it, and may answer with a fresh one, so a pass lives as long as the
 * device is used rather than from the day it was given. One it no longer takes
 * — the subscription behind it ended, say — is let go of here, and the gate
 * asks for a code again before any consent screen rather than after one. Not
 * asked, or not answered, it is kept: the callback still decides, as it always
 * did. An answer about a value no longer held, because a new code was typed
 * meanwhile, is not the answer about this one, and changes nothing.
 *
 * After the refusal of a connect that carried a typed code, which lets go of
 * the code first (`useConnectNotice`), there is nothing left to ask about; a
 * held value is kept through a refusal (`codeWasRefused`) and asked about here.
 */
const useCodeAskedAgain = (connect: ConnectOutcome | undefined) => {
	const config = useInstanceConfig(api);
	const asksForCode = answer(config)?.connectGate?.connectCode !== undefined;
	const asked = useRef(false);
	const [refused] = useState(connect === 'refused');
	useEffect(() => {
		if (!asksForCode || asked.current) return;
		asked.current = true;
		const held = heldConnectCode();
		if (held === undefined || heldConnectCodeShown()) return;
		if (!refused && Date.now() - (connectCodeAskedAt() ?? 0) < ASK_AGAIN_MS) return;
		void api.checkConnectCode(held).then(
			(result) => {
				if (!result.ok || heldConnectCode() !== held) return;
				if (result.value.accepted) holdAcceptedCode(held, result.value);
				else dropConnectCode();
			},
			() => {
				// A limit reached or no answer at all: kept, as it was.
			}
		);
	}, [asksForCode, refused]);
};

/**
 * The toast for how a connect went, read once as the app opens on the way back
 * from the provider and taken out of the URL straight away: left there, a
 * reload or a bookmark would say "connected" again about a connection that may
 * since have gone.
 *
 * Except that a new source's "connected" is the import dialog's to say, and
 * a toast behind it — under a held app, where it cannot be dismissed — says it
 * twice. Whether the app will be held is not known on arrival: the bind that
 * decides it comes after a round trip to the server (`claimConnection`), so
 * "connected" waits while the credential brought back is still being taken up,
 * and is dropped once an import holds the app. Every other outcome says
 * something went wrong, and is shown at once.
 */
const useConnectNotice = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined,
	held: SyncStateRecord | undefined
) => {
	const navigate = useNavigate({ from: Route.fullPath });
	const [outcome, setOutcome] = useState(connect);
	const [refusedAs] = useState(code);
	const [codeRefused] = useState(() => codeWasRefused(connect, code));
	// So the field is empty for the next code, rather than offering again the one
	// just turned down.
	useEffect(() => {
		if (codeRefused) dropConnectCode();
	}, [codeRefused]);
	// The operator's gate, whose action is the one thing a refused toast can
	// offer to do. The same request the connect buttons make (`instanceConfig`).
	const config = useInstanceConfig(api);
	const gate = answer(config)?.connectGate;
	useEffect(() => {
		if (connect === undefined && code === undefined) return;
		void navigate({
			search: ({ connect: _outcome, code: _code, ...rest }) => rest,
			replace: true,
		});
	}, [connect, code, navigate]);

	const claiming = useClaimingConnection();
	// Dropped for good, in render rather than an effect (React's "adjusting
	// state when a prop changes"): the import finishing must not bring it back.
	if (outcome === 'ok' && held !== undefined) setOutcome(undefined);

	const dismissConnect = useCallback(() => {
		setOutcome(undefined);
	}, []);
	// Whether there is a message at all decides whether a toast is rendered, and
	// `connectMessage` answers `undefined` for an outcome this build has no
	// words for (see above).
	//
	// A refusal waits for the instance's config, answered or not: its link is
	// part of the message, and an alert that grows a link a moment after it
	// appears is an alert a screen reader reads twice. Never for long — the
	// server has only just sent the browser here.
	const waiting =
		(outcome === 'ok' && (claiming || held !== undefined)) ||
		(outcome === 'refused' && config.kind === 'asking');
	const connectNotice =
		outcome === undefined || waiting
			? undefined
			: connectMessage(outcome, refusedAs, gate, codeRefused);
	return { connectNotice, dismissConnect };
};

/**
 * Whether the notebook and note in the URL were chosen in another source than
 * the one showing — true from the moment the source changes until they have
 * been taken out of the URL.
 *
 * Each source is its own notebooks and its own notes (§6), so a path or an id
 * from one names nothing in another, or worse, names something: a notebook
 * called "Inbox" in both would open the new source's "Inbox", not where the
 * user last was in it. So the URL is emptied of both when the source changes,
 * however it changed — a tab, a search answer in another source, a connect,
 * a disconnect — and the source's remembered place takes over.
 *
 * The first source known is the one the URL was opened in. A URL naming
 * nothing belongs to whichever source is showing.
 */
const useUrlFromElsewhere = (
	activeConnection: string | undefined,
	search: Pick<AppSearch, 'folder' | 'note'>
): boolean => {
	const navigate = useNavigate({ from: Route.fullPath });
	const [urlSource, setUrlSource] = useState<string | undefined>(undefined);
	const placed = search.folder !== undefined || search.note !== undefined;
	const elsewhere =
		urlSource !== undefined && activeConnection !== undefined && urlSource !== activeConnection;
	// In render rather than an effect (React's "adjusting state when a prop
	// changes"), so that no render reads the URL as the wrong source's.
	if (
		activeConnection !== undefined &&
		urlSource !== activeConnection &&
		(urlSource === undefined || !placed)
	) {
		setUrlSource(activeConnection);
	}
	useEffect(() => {
		if (!elsewhere) return;
		void navigate({
			search: ({ folder: _folder, note: _note, ...rest }) => rest,
			replace: true,
		});
	}, [elsewhere, navigate]);
	return elsewhere;
};

/** The remembered notebook as `selectedFolderPath` takes it: `null` for none. */
const rememberedFolder = (lastOpen: LastOpen | undefined): string | null | undefined =>
	lastOpen === undefined ? undefined : (lastOpen.folder ?? null);

/**
 * Keep the device's memory of where the user is (`store/lastOpen.ts`) in step
 * with what is open: the notebook, and the note while it is one of that
 * notebook's. Written only once the memory has been read, so a place is never
 * remembered over one that was about to be restored.
 */
const useRememberOpen = ({
	connectionId,
	folder,
	noteId,
	openNote,
	lastOpen,
}: {
	connectionId: string | undefined;
	folder: string | undefined;
	noteId: string | undefined;
	openNote: NoteRecord | undefined;
	lastOpen: LastOpen | undefined;
}) => {
	// The note in the URL, by id: `useNote` keeps the note it last found while
	// it looks for the next one, and that one is not open.
	const note =
		openNote !== undefined &&
		openNote.id === noteId &&
		folder !== undefined &&
		noteIsUnder(openNote.path, folder)
			? openNote.id
			: undefined;
	useEffect(() => {
		if (connectionId === undefined || folder === undefined || lastOpen === undefined) return;
		const known =
			lastOpen.folder === folder && (note === undefined || lastOpen.notes[folder] === note);
		if (known) return;
		void rememberOpen(db, connectionId, folder, note);
	}, [connectionId, folder, note, lastOpen]);
};

/**
 * The note begun and not yet stored, if one is open (`draftNote`), and what the
 * note pane may do with it (`NoteDraft`).
 *
 * In memory and nowhere else until the user edits it: a keystroke in its body
 * or a name given to it stores it, as it is, and from then on it is a note like
 * any other. Left unedited it simply stops being open, and nothing was written
 * — not to the device, and so not to the user's folder either.
 */
const useDrafts = ({
	connectionId,
	noteId,
	storedNote,
	onStoreFailed,
}: {
	connectionId: string | undefined;
	noteId: string | undefined;
	/** The stored note the URL names, which a draft becomes once it is stored. */
	storedNote: NoteRecord | undefined;
	onStoreFailed: () => void;
}) => {
	const [draft, setDraft] = useState<NoteRecord | null>(null);
	/** Each draft is stored once, however many edits ask. */
	const storing = useRef(new Map<string, Promise<boolean>>());

	// Stored, and a note now: let it go, in render rather than an effect, so no
	// render shows the draft over its own row.
	if (draft !== null && storedNote?.id === draft.id) setDraft(null);

	const open =
		draft !== null && draft.id === noteId && draft.connectionId === connectionId
			? draft
			: undefined;

	/** Begin a note in `folderPath`, beside notes already called `taken`. */
	const begin = useCallback(
		(folderPath: string, taken: readonly string[]): NoteRecord | undefined => {
			if (connectionId === undefined) return undefined;
			const made = draftNote({ connectionId, folderPath, taken });
			setDraft(made);
			return made;
		},
		[connectionId]
	);

	const store = useCallback(
		(note: NoteRecord): Promise<boolean> => {
			const known = storing.current.get(note.id);
			if (known !== undefined) return known;
			const stored = createNote(db, {
				connectionId: note.connectionId,
				folderPath: parentPath(note.path),
				id: note.id,
				createdAt: note.createdAt,
				...(note.editorMode === undefined ? {} : { editorMode: note.editorMode }),
			}).then(
				(created) => {
					// A note in the device's own library exists nowhere else, and
					// the user has just written in it: the moment the browser can
					// be asked to keep it, prompt and all, once per device
					// (`store/keeping.ts`).
					if (created.connectionId === LOCAL_CONNECTION_ID) {
						void keeping.ask(db, 'first-note');
					}
					return true;
				},
				() => {
					onStoreFailed();
					return false;
				}
			);
			storing.current.set(note.id, stored);
			return stored;
		},
		[onStoreFailed]
	);

	const noteDraft = useMemo((): NoteDraft | undefined => {
		if (open === undefined) return undefined;
		return {
			store: () => store(open),
			setMode: (mode) => {
				setDraft((current) =>
					current?.id === open.id ? { ...current, editorMode: mode } : current
				);
				// An edit may have begun storing it with the mode it had.
				void storing.current.get(open.id)?.then((stored) =>
					stored
						? setNoteEditorMode(db, open.id, mode, {
								connectionId: open.connectionId,
							})
						: undefined
				);
			},
		};
	}, [open, store]);

	return { draft, open, begin, noteDraft };
};

/**
 * Which notebook and note are open.
 *
 * The notebook is the URL's, else the one open last on this device, else the
 * first (`selectedFolderPath`). The note is the URL's while it is there to
 * show, else the one open last in that notebook, else the notebook's first
 * (`pickNote`) — and that answer is written to the URL, so the note list, the
 * editor and a reload all agree on it. A notebook with no notes in it starts
 * one (`useDrafts`), unless it is the loose notes, where the app makes none
 * (§12.6), or `startable` says notes are still arriving.
 *
 * One path for every way a notebook comes to be showing: clicked, restored at
 * start, fallen back to after a delete, or a source's first notebook as a
 * first import fills it. Opening a note used to follow a click on a notebook
 * and nothing else, so a notebook the app opened by itself showed a list
 * beside an empty pane.
 */
const useOpenPlace = ({
	search,
	activeConnection,
	tree,
	looseNoteCount,
	pins,
	startable,
	onStoreFailed,
}: {
	search: AppSearch;
	activeConnection: string | undefined;
	tree: FolderNode[] | undefined;
	looseNoteCount: number | undefined;
	/** What the source has pinned: a notebook opens on a pinned note first. */
	pins: Pins | undefined;
	/**
	 * Whether an empty notebook may start a note. Not while a source's first
	 * import is filling it: the notebook is empty only because its notes have
	 * not arrived yet.
	 */
	startable: boolean;
	onStoreFailed: () => void;
}) => {
	const navigate = useNavigate({ from: Route.fullPath });
	const elsewhere = useUrlFromElsewhere(activeConnection, search);
	const requestedFolder = elsewhere ? undefined : search.folder;
	const noteId = elsewhere ? undefined : search.note;
	const lastOpen = useLastOpen(activeConnection);
	const folder = selectedFolderPath(
		tree,
		folderFromSearch(requestedFolder),
		looseNoteCount,
		rememberedFolder(lastOpen)
	);
	const remembered = folder === undefined ? undefined : lastOpen?.notes[folder];
	const pinnedNotes = pins?.notes;
	const toOpen = useNoteToOpen({
		connectionId: activeConnection,
		folder,
		open: noteId,
		remembered,
		pinned: pinnedNotes,
		ready: lastOpen !== undefined && !elsewhere,
	});

	const found = useNote(noteId);
	// By id: `useNote` keeps the note it last found while it looks for the next.
	const storedNote = found?.id === noteId ? found : undefined;
	const drafts = useDrafts({
		connectionId: activeConnection,
		noteId,
		storedNote,
		onStoreFailed,
	});
	const { draft, begin } = drafts;
	const begun = drafts.open;

	useEffect(() => {
		// A note begun is open, though it is not in the store to be found.
		if (begun !== undefined || activeConnection === undefined) return undefined;
		// The note the URL names is there to show, so there is nothing to choose
		// (`pickNote` answers the same). Asked here, not left to that answer: it
		// can be one worked out while the note was still begun and not stored —
		// when the notebook's remembered note was the answer — and arrive after
		// the note it was about has been stored.
		if (storedNote?.deletedLocally === 0) return undefined;
		// An answer to the question as it stands, not to one asked a click ago.
		if (toOpen === undefined || toOpen.folder !== folder || toOpen.open !== noteId) {
			return undefined;
		}
		const show = (pick: string | undefined) => {
			if (pick === noteId) return;
			void navigate({
				// And only onto the URL it was worked out from: the user may have
				// clicked somewhere else while the store was answering.
				search: (current) =>
					current.folder === requestedFolder && current.note === noteId
						? { ...current, folder: folderToSearch(toOpen.folder), note: pick }
						: current,
				replace: true,
			});
		};
		if (!beginsHere(toOpen, startable)) {
			show(toOpen.pick ?? undefined);
			return undefined;
		}
		// One already begun here and left is the same blank page, so it is
		// opened again rather than another made beside it.
		const blank = () =>
			draft !== null &&
			draft.connectionId === activeConnection &&
			parentPath(draft.path) === toOpen.folder
				? draft
				: begin(toOpen.folder, []);
		// Empty by a read that may already be behind: an undo or a pull can put
		// a note in the notebook between that read and this, and a note opened
		// over it would hide the one that arrived. So the store is asked again,
		// now, and nothing is opened for a question that has moved on meanwhile.
		const asking = { current: true };
		void pickNote(db, {
			connectionId: activeConnection,
			folderPath: toOpen.folder,
			open: noteId,
			remembered,
			pinned: pinnedNotes,
		}).then((again) => {
			if (asking.current) show(again ?? blank()?.id);
		});
		return () => {
			asking.current = false;
		};
	}, [
		toOpen,
		folder,
		noteId,
		requestedFolder,
		remembered,
		pinnedNotes,
		navigate,
		begun,
		storedNote,
		startable,
		draft,
		activeConnection,
		begin,
	]);

	useRememberOpen({
		connectionId: activeConnection,
		folder,
		noteId,
		openNote: storedNote,
		lastOpen,
	});

	return {
		folder,
		noteId,
		/** The note open: stored, or begun and not yet. */
		openNote: storedNote ?? begun,
		storedNote,
		begun,
		begin,
		noteDraft: drafts.noteDraft,
	};
};

/**
 * Whether the store's answer is a notebook with nothing in it, where
 * `useOpenPlace` begins a note: not the loose notes, which the app never adds
 * to, and not while `startable` says notes are still arriving.
 */
const beginsHere = ({ folder, pick }: NoteToOpen, startable: boolean): boolean =>
	pick === null && startable && folder !== ROOT;

/**
 * Whether an empty notebook may begin a note (`useOpenPlace`): once the source
 * is known, and not while its first import is still bringing its notes in.
 */
const canBegin = (
	source: SyncStateRecord | null | undefined,
	held: SyncStateRecord | undefined
): boolean => source !== undefined && source?.importing === undefined && held === undefined;

/**
 * The open notebook's notes, the pinned first (`store/pins.ts`), and the note
 * begun in it as the newest, though the store has no row for it yet: at the
 * top of the ones that are not pinned. The pins come with the tree
 * (`usePinnedTree`), which is read before any notebook is open.
 */
const useListedNotes = (
	folder: string | undefined,
	begun: NoteRecord | undefined,
	pins: Pins | undefined
) => {
	const stored = useNotesInFolder(folder);
	const notes = useMemo(() => {
		if (stored === undefined) return undefined;
		const pinned = (note: NoteRecord) => pins?.notes.has(note.id) === true;
		const sorted = pinnedFirst(stored, pinned);
		if (
			begun === undefined ||
			parentPath(begun.path) !== folder ||
			stored.some((note) => note.id === begun.id)
		)
			return sorted;
		const at = sorted.filter(pinned).length;
		return [...sorted.slice(0, at), begun, ...sorted.slice(at)];
	}, [stored, begun, folder, pins]);
	return { stored, notes, unsavedNoteId: begun?.id };
};

/**
 * A note begun is named next, and the cursor goes to its name, so in a compact
 * window it is the note that shows and not a dropdown over it. Choosing a
 * notebook or pressing `+` shut the dropdown already; making a notebook —
 * always one with nothing in it — and deleting a notebook's last note did not,
 * and left the cursor in a field nobody could see.
 */
const useBegunInView = (begun: NoteRecord | undefined, shut: (panel: null) => void) => {
	const id = begun?.id;
	useEffect(() => {
		if (id !== undefined) shut(null);
	}, [id, shut]);
};

const Home = () => {
	const search = Route.useSearch();
	const { connect, code, enter, share } = search;
	const navigate = useNavigate({ from: Route.fullPath });
	// Where a connect started from the tab bar should come back to.
	const href = useRouterState({ select: (state) => state.location.href });

	const source = useActiveSource();
	// A new source's import holds the app, the first's and every one after:
	// nothing may be done in it, or to the notes being moved into it, until
	// it is through.
	const held = useHeldImport();
	const { connectNotice, dismissConnect } = useConnectNotice(connect, code, held);
	useCodeAskedAgain(connect);
	const activeConnection = useActiveConnectionId();
	const openNotebooks = useOpenNotebooks(activeConnection);
	const onOpenNotebooks = useCallback(
		(paths: string[], open: boolean) => {
			if (activeConnection !== undefined)
				void setNotebooksOpen(db, activeConnection, paths, open);
		},
		[activeConnection]
	);
	const sources = useSources();
	const { tree, pins } = usePinnedTree();
	const looseNoteCount = useLooseNoteCount();

	/**
	 * Why the last thing the user asked for did not happen. Creating a notebook
	 * or a note can reject — a duplicate name is the everyday case — and by then
	 * the name field has closed and the click is over, so without somewhere to
	 * put this the user acts and the app shows nothing at all.
	 */
	const [problem, setProblem] = useState<Notice | null>(null);
	/** What is typed into the open note before it is saved, for the list to show. */
	const [liveEdits] = useState(createLiveEdits);
	/** A notebook or source being renamed, for everything else that names it. */
	const [renamings] = useState(createRenamings);
	// Rarer than a duplicate notebook name — this one needs the store itself to
	// refuse — but the same silence if it happens: the user types into a note
	// that is nowhere, and the failure goes to the console.
	const noteNotMade = useCallback(() => {
		setProblem({ message: 'That note could not be made.', tone: 'error' });
	}, []);

	const place = useOpenPlace({
		search,
		activeConnection,
		tree,
		looseNoteCount,
		pins,
		startable: canBegin(source, held),
		onStoreFailed: noteNotMade,
	});
	const { folder, noteId, openNote, storedNote } = place;
	const { stored, notes, unsavedNoteId } = useListedNotes(folder, place.begun, pins);
	// Read by a continuation that finishes after the user may have moved on.
	/** The note pane, which deletes a note from the list's menu as from its own. */
	const noteView = useRef<NoteViewHandle>(null);
	const noteIdRef = useRef(noteId);
	useEffect(() => {
		noteIdRef.current = noteId;
	}, [noteId]);

	/**
	 * What is in the search field. Component state and not the URL, unlike the
	 * open folder and note: those are where the user *is*, and a reload should
	 * land there. A half-typed query is not a place — reopening the app into
	 * somebody's last search, with the notebooks hidden behind its results, is
	 * not where they left off.
	 */
	const [query, setQuery] = useState('');
	const results = useNoteSearch(query);
	/**
	 * What a search result calls the source it is in. Said only when there is
	 * more than one: with a single source every row would say the same thing.
	 */
	const resultSourceName = (connectionId: string): string | undefined => {
		if (sources === undefined || sources.length < 2) return undefined;
		const found = sources.find((each) => each.connectionId === connectionId);
		return found === undefined ? undefined : tabName(found, sources);
	};

	/**
	 * A window too narrow for three panes. The notebooks and the notes become
	 * dropdowns in the bar and the note takes the rest (`CompactBar`); `panel`
	 * is which of them is open, and `searchOpen` whether the search has the bar.
	 */
	const {
		compact,
		panel,
		setPanel,
		searchOpen,
		setSearchOpen,
		setOrigins,
		frameClassName,
		shellProps,
	} = useCompactLayout();
	useBegunInView(place.begun, setPanel);
	const enterCode = useEnterCode(enter, compact, setPanel);
	// Something shared to the app (`share/TakeShare.tsx`): out of the URL once
	// read, so a reload does not ask again, and the clipboard brought into
	// view once it has it, which in a compact window is in the sources
	// dropdown.
	const shareRead = useCallback(() => {
		void navigate({ search: ({ share: _share, ...rest }) => rest, replace: true });
	}, [navigate]);
	const shareAdded = useCallback(() => {
		if (compact) setPanel('sources');
	}, [compact, setPanel]);
	// The answers hang from the field, over whatever else is open; a dropdown
	// left open under them would be a second list behind the first.
	const onQuery = (next: string) => {
		setQuery(next);
		setPanel(null);
	};

	const [paletteOpen, setPaletteOpen] = useState(false);
	/**
	 * The search field, so a command can put the cursor in it. A command that
	 * only *said* "search" and left the user to find the box would be a slower
	 * way of doing nothing.
	 */
	const searchField = useRef<HTMLInputElement>(null);

	const select = (next: Partial<AppSearch>) => {
		// Anything else the user does answers the banner: it is about the name they
		// just tried, not about the app, and leaving it up means a message about a
		// notebook they have since moved on from sits there for the session.
		setProblem(null);
		dismissConnect();
		void navigate({ search: (current) => ({ ...current, ...next }), replace: true });
	};

	/**
	 * Open a notebook. Only a note under the open notebook can be open, so the
	 * note showing stays only while it is under the one clicked — in it, or in
	 * a notebook inside it, at any depth (`noteIsUnder`). Clicking a parent of
	 * the note's own notebook used to clear it and leave an empty editor beside
	 * a list, which was the reported bug. Anywhere else the note is let go, and
	 * the notebook's own opens in its place (`useOpenPlace`): the one open last
	 * in it on this device, or its first.
	 */
	const openFolder = (path: string) => {
		const keep = openNote !== undefined && noteIsUnder(openNote.path, path);
		select(
			keep
				? { folder: folderToSearch(path) }
				: { folder: folderToSearch(path), note: undefined }
		);
	};

	/**
	 * Open a search result. A result can be in any source and any notebook, and
	 * opening one has to take the user to all of it: the source first, since
	 * the notebook and the note named in the URL are read inside whichever
	 * source is showing, and then the notebook and the note together. Left in
	 * the source or the notebook they were in, the sidebar would highlight one
	 * place while the note beside it came from another, and clearing the search
	 * would leave the open note nowhere in the list.
	 */
	const openResult = (note: NoteRecord) => {
		// Done with: the field has emptied itself, and in a compact window the
		// bar goes back to its dropdowns rather than staying a search.
		setSearchOpen(false);
		setPanel(null);
		if (note.connectionId === activeConnection) {
			select({ folder: folderToSearch(parentPath(note.path)), note: note.id });
			return;
		}
		// Another source: the URL is emptied as the source changes
		// (`useUrlFromElsewhere`), so the way to arrive somewhere in it is to be
		// remembered there first.
		setProblem(null);
		dismissConnect();
		void rememberOpen(db, note.connectionId, parentPath(note.path), note.id).then(() =>
			showConnection(db, note.connectionId)
		);
	};

	/**
	 * The note just deleted, as it was, for as long as the delete can be taken
	 * back. Here rather than in `NoteView`, which stops showing a note the moment
	 * it is a tombstone. One at a time: a second delete takes the notice over and
	 * the first note simply stays deleted.
	 */
	const [deleted, setDeleted] = useState<NoteRecord | null>(null);
	/** The note (`noteRef`) whose undo failed: its notice waits to be dismissed. */
	const [undoFailed, setUndoFailed] = useState<string | null>(null);
	/** Text that goes back beside the deleted note, not into it (`NoteView`). */
	const [beside, setBeside] = useState<DisplacedText | null>(null);
	const dismissDeleted = useCallback(() => {
		setDeleted(null);
	}, []);
	const dismissProblem = useCallback(() => {
		setProblem(null);
	}, []);

	const undoDelete = () => {
		if (deleted === null) return;
		void undeleteNote(db, deleted)
			.then(async (restored) => {
				setUndoFailed(null);
				if (beside !== null) {
					await saveNoteBody(db, restored.id, beside.body, {
						origin: beside.origin,
						note: restored,
						displaced: true,
					});
				}
				setDeleted((current) =>
					current !== null && noteRef(current) === noteRef(deleted) ? null : current
				);
				// It goes back to the source it was deleted from, which need not be
				// the one showing by now: the notice outlives a change of source.
				// Nor need it still be connected. A note is never brought back into
				// the device's own pile or into another account (`homeOf`), so one
				// whose source was let go meanwhile is in that source, detached, and
				// the user is told where to look and what can be done with it there.
				if (restored.connectionId !== (await activeConnectionId(db))) {
					const home = await db.syncState.get(restored.connectionId);
					// Not every one of these is a problem, and with a colour on
					// them that stops being a detail: the note came back, which
					// is what was asked for. It is a warning only where it came
					// back somewhere the user cannot sync it from.
					setProblem(
						home?.detached === undefined
							? {
									message: `“${restored.title}” is back, in the source it was deleted from.`,
									tone: 'success',
								}
							: {
									message: `“${restored.title}” is back, in ${sourceName(home) ?? 'its source'}, which is disconnected. Reconnect it, or download the note.`,
									tone: 'warning',
								}
					);
					return;
				}
				// Back where it was, open. By the row's own path, not the one it
				// was deleted at: once sync has purged the row the note is made
				// again, under a conflict name if something took the old one.
				select({
					note: restored.id,
					folder: folderToSearch(parentPath(restored.path)),
				});
			})
			// The notice stays, and for as long as it takes: the note is still
			// deleted, still offered, and what it holds may be in no other place.
			.catch(() => {
				setUndoFailed(noteRef(deleted));
				setProblem({
					message: 'That note could not be brought back. Try again.',
					tone: 'error',
				});
			});
	};

	/**
	 * Begin a note in the open notebook: on screen, named "Untitled" with the
	 * name selected, and stored only once the user writes in it (`useDrafts`).
	 */
	const onCreateNote = () => {
		// The root holds loose notes that arrived from the remote folder; the app
		// does not add to them (docs/ARCHITECTURE.md §12.6).
		if (folder === undefined || folder === ROOT) return;
		const made = place.begin(
			folder,
			(stored ?? []).map((note) => basename(note.path))
		);
		if (made !== undefined) select({ folder: folderToSearch(folder), note: made.id });
	};

	const onCreateFolder = (parentPath: string | undefined, name: string) => {
		// `createFolder` throws on a duplicate name, and the field has already
		// closed by the time it does: without this the user types a name, presses
		// Enter, and nothing whatsoever happens — plus an unhandled rejection.
		setProblem(null);
		void createFolder(db, { parentPath, name })
			.then((created) => {
				openFolder(created.path);
			})
			.catch((error: unknown) => {
				setProblem(
					error instanceof FolderExistsError
						? {
								message: `There is already a notebook called “${error.folderName}” here.`,
								tone: 'warning',
							}
						: { message: 'That notebook could not be made.', tone: 'error' }
				);
			});
	};

	// A notebook's new name, given, is shown until the open notebook is no
	// longer at the old path: then the URL names it by the new one, and the
	// store does too (`store/renaming.ts`). Listened to rather than read, so a
	// keystroke in the field does not redraw the route.
	useEffect(() => {
		const settle = () => {
			const renaming = renamings.get();
			if (renaming?.kind !== 'notebook' || renaming.given === undefined) return;
			if (folder === undefined || !isWithin(folder, renaming.key))
				renamings.clear('notebook', renaming.key);
		};
		settle();
		return renamings.subscribe(settle);
	}, [renamings, folder]);

	const onRenameFolder = (path: string, name: string) => {
		setProblem(null);
		void renameFolder(db, path, name)
			.catch((error: unknown) => {
				// Not renamed: the name it had is the one to show.
				renamings.clear('notebook', path);
				throw error;
			})
			.then((to) => {
				// Same reason the move below rebases: the URL names the open
				// notebook by path, and this has changed it.
				if (folder !== undefined && isWithin(folder, path)) {
					select({ folder: folderToSearch(rebasePath(folder, path, to)) });
				}
			})
			.catch((error: unknown) => {
				setProblem(
					error instanceof FolderExistsError
						? {
								message: `There is already a notebook called “${error.folderName}” here.`,
								tone: 'warning',
							}
						: { message: 'That notebook could not be renamed.', tone: 'error' }
				);
			});
	};

	const onDeleteFolder = (path: string) => {
		setProblem(null);
		// Asked about before this is called: the sidebar puts the question, with
		// the count of what goes with it, because everything beneath a notebook
		// is tombstoned and pushed as a deletion.
		void deleteFolder(db, path)
			.then(() => {
				const goneFolder = folder !== undefined && isWithin(folder, path);
				const goneNote = openNote !== undefined && isWithin(openNote.path, path);
				// Both are named in the URL and neither is there any more. Left
				// alone the app opens a notebook that has gone — `selectedFolderPath`
				// falls back to the first one, but only once something asks it to.
				if (goneFolder || goneNote) {
					select({
						...(goneFolder ? { folder: undefined } : {}),
						...(goneNote ? { note: undefined } : {}),
					});
				}
			})
			.catch(() => {
				setProblem({ message: 'That notebook could not be deleted.', tone: 'error' });
			});
	};

	/**
	 * What the user has picked up, by dragging it or by running the command.
	 *
	 * One piece of state for both, and it lives here rather than in either pane
	 * because the two ends of a note's move are in different ones: the row is in
	 * the note list and every destination is in the sidebar. What is allowed to
	 * land where is in `store/rearrange.ts`, which knows nothing about React.
	 */
	const [moving, setMoving] = useState<Moving | null>(null);

	const cancelMove = useCallback(() => {
		setMoving(null);
	}, []);

	/**
	 * What a compact window shows once a notebook is chosen: its notes, to
	 * choose one from next, as a source chosen goes on to its notebooks. Not
	 * for a notebook with no notes, where a note begins and is what shows
	 * (`useBegunInView`) — the notes would be opened only to be shut on it.
	 */
	const afterFolder = (path: string): Pane | null =>
		compact &&
		!(
			path !== ROOT &&
			tree !== undefined &&
			findFolder(tree, path)?.noteCount === 0 &&
			canBegin(source, held)
		)
			? 'notes'
			: null;

	/**
	 * How many times an empty state has asked for a new notebook. The field is
	 * the sidebar's, so this is a request it answers rather than state it
	 * shares — and the sidebar is opened for it in a compact window, where it
	 * is a dropdown the field would otherwise be hidden in.
	 */
	const [newNotebookAsked, setNewNotebookAsked] = useState(0);
	const askNewNotebook = () => {
		setNewNotebookAsked((times) => times + 1);
		if (compact) setPanel('notebooks');
	};

	/**
	 * Every destination is a sidebar row, and in a compact window the sidebar
	 * is a dropdown that may be shut — so picking something up opens it, or a
	 * move begun from the palette would be a mode with nowhere to finish it.
	 */
	const pickUp = (what: Moving) => {
		setMoving(what);
		if (compact) setPanel('notebooks');
	};

	/**
	 * Escape puts down whatever is being moved, from wherever the focus is. On
	 * the document rather than on the sidebar: a move started from the palette
	 * leaves the focus where the palette had it, which may be nowhere near the
	 * destinations, and a mode with no way out is worse than no mode.
	 */
	useEffect(() => {
		if (moving === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setMoving(null);
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
		};
	}, [moving]);

	const onDropInto = (into: string) => {
		if (moving === null) return;
		const move = dropMove(moving, into);
		// Put down first: the move is a round trip through the store and a mode
		// left standing over it is one the user can drop a second copy of.
		setMoving(null);
		setPanel(null);
		if (move === undefined) return;
		setProblem(null);

		if (move.kind === 'note') {
			// What the editor holds is saved first: a file pasted into the note
			// a moment ago is carried by the links its body has stored
			// (`carryLinkedFiles`), and left behind by one that has not been.
			void settleEditors()
				.then(() => moveNote(db, move.id, move.into))
				.then(() => {
					// Only when it is the note in front. A note dragged out of the
					// list the user is reading leaves it, which is the whole of what
					// they asked for; the one they are *writing in* would otherwise
					// be open beside a sidebar highlighting the notebook it has just
					// left, which is the disagreement opening a search result also
					// has to avoid.
					if (noteIdRef.current === move.id) {
						select({ folder: folderToSearch(move.into) });
					}
				})
				.catch(() => {
					setProblem({ message: 'That note could not be moved.', tone: 'error' });
				});
			return;
		}

		void moveFolder(db, move.from, move.to)
			.then(() => {
				// The open notebook is named by path in the URL, and the move has
				// just changed it — for the notebook itself and for everything
				// under it. Left alone, the URL names a notebook that is no longer
				// there and `selectedFolderPath` falls back to the first one, so
				// moving the notebook you are in throws you out of it.
				if (folder !== undefined && isWithin(folder, move.from)) {
					select({ folder: folderToSearch(rebasePath(folder, move.from, move.to)) });
				}
			})
			.catch((error: unknown) => {
				setProblem(
					error instanceof FolderExistsError
						? {
								message: `There is already a notebook called “${error.folderName}” there.`,
								tone: 'warning',
							}
						: { message: 'That notebook could not be moved.', tone: 'error' }
				);
			});
	};

	useCommand({
		id: 'app.palette',
		label: 'Show all commands',
		group: 'App',
		chord: PALETTE,
		enabled: true,
		run: () => {
			setPaletteOpen(true);
		},
	});

	useCommand({
		id: 'note.new',
		label: 'New note',
		group: 'Note',
		chord: NEW_NOTE,
		// The root holds loose notes that came from the remote folder and the app
		// does not add to them, so there is nowhere to put a note until a notebook
		// is open (docs/ARCHITECTURE.md §12.6).
		enabled: folder !== undefined && folder !== ROOT,
		run: onCreateNote,
	});

	useCommand({
		id: 'app.search',
		label: 'Search notes',
		group: 'App',
		chord: FIND,
		enabled: true,
		run: () => {
			// In a compact window the field is not there until the search is
			// open; the bar puts the cursor in it as it appears.
			setSearchOpen(true);
			searchField.current?.focus();
			searchField.current?.select();
		},
	});

	useDownloadCommand({ connectionId: activeConnection, source, onProblem: setProblem });

	useCommand({
		id: 'note.undoDelete',
		label: 'Undo delete',
		group: 'Note',
		enabled: deleted !== null,
		run: undoDelete,
	});

	/**
	 * Picking up without a pointer. Dragging is a pointer gesture, and WCAG 2.2
	 * SC 2.5.7 asks that whatever it does be doable without one; these two put
	 * the same thing in the air that `dragstart` does, and the destination rows
	 * in the sidebar are ordinary buttons, so a click or Enter on one puts it
	 * down. No chord: they are rare enough to be found in the palette, and every
	 * chord taken is one a note cannot use.
	 */
	useCommand({
		id: 'notebook.move',
		label: 'Move notebook',
		group: 'Notebook',
		// The root is not a notebook and cannot be moved, and neither can a
		// second thing while one is already in the air.
		enabled: folder !== undefined && folder !== ROOT && moving === null,
		run: () => {
			if (folder === undefined || folder === ROOT) return;
			pickUp({ kind: 'notebook', path: folder, name: basename(folder) });
		},
	});

	// A note begun and not stored has nowhere to move from yet.
	useNoteMove(storedNote, moving, pickUp);
	useKeepOnInstall();

	useShortcuts();

	return (
		// `app-shell` is a three-column grid with exactly three children. A banner
		// put inside it becomes a fourth grid item, takes the sidebar's column and
		// pushes the note view into a clipped second row, so anything that sits
		// above the panes goes in the frame around them instead. The toasts are
		// not laid out at all — they are fixed to the viewport — but they are
		// here for the same reason: a stack in the grid would take a column.
		<div className={frameClassName} inert={held !== undefined}>
			{/*
			 * Above everything, because it says which app this is: each source
			 * is its own notes, its own notebooks and its own sync (§6), so the
			 * panes below all mean something different depending on which of
			 * these is lit.
			 */}
			{compact ? (
				<CompactBar
					folder={folder}
					note={openNote}
					liveEdits={liveEdits}
					renamings={renamings}
					panel={panel}
					onPanel={setPanel}
					query={query}
					onQuery={onQuery}
					results={results}
					onChoose={openResult}
					sourceName={resultSourceName}
					searchOpen={searchOpen}
					onSearchOpen={setSearchOpen}
					fieldRef={searchField}
					onOrigins={setOrigins}
				/>
			) : (
				<SourceTabs
					returnTo={returnPath(href)}
					enterCode={enterCode}
					search={
						<SearchField
							query={query}
							onQuery={setQuery}
							results={results}
							onChoose={openResult}
							sourceName={resultSourceName}
							fieldRef={searchField}
						/>
					}
				/>
			)}
			{/*
			 * Under the bar rather than over it: the bar is the top of the window
			 * to a compact window's search, which hangs from it to the foot.
			 */}
			<InstallBanner />
			{/*
			 * For as long as a detached source is the one showing, and not
			 * dismissable: its notes look like any others, can be opened and
			 * written in like any others, and sync nowhere. `role="note"` rather
			 * than `status`, as a standing remark about what is on screen and not
			 * news of something that has just happened.
			 */}
			{source?.detached !== undefined && (
				<p className="banner" role="note">
					{sourceName(source) ?? 'This source'} is disconnected. What is here has changes{' '}
					{source.provider === undefined ? 'it' : PROVIDER_LABELS[source.provider]} was
					never sent, and nothing written here is synced. Reconnect it, or download or
					discard them, from the storage panel.
				</p>
			)}
			{paletteOpen && (
				<CommandPalette
					onClose={() => {
						setPaletteOpen(false);
					}}
				/>
			)}

			{/* `data-panel` is which pane a compact window is showing as a
			    dropdown; the stylesheet ignores it in a wide one. */}
			<div className="app-shell" {...shellProps}>
				{/* Positioned, like the two panes in a compact window, so it is
				    never a grid item and takes no column. */}
				<SourceDropdown
					compact={compact}
					enterCode={enterCode}
					renamings={renamings}
					returnTo={returnPath(href)}
					onChosen={() => {
						setPanel('notebooks');
					}}
				/>
				<Sidebar
					tree={tree}
					selectedFolder={folder}
					onSelectFolder={(path) => {
						openFolder(path);
						setPanel(afterFolder(path));
					}}
					onCreateFolder={onCreateFolder}
					onRenameFolder={onRenameFolder}
					onDeleteFolder={onDeleteFolder}
					renamings={renamings}
					looseNoteCount={looseNoteCount}
					// In a compact window it is in the source dropdown instead,
					// which is where a phone user goes for anything about storage.
					{...(compact ? {} : { footer: <AccountPanel /> })}
					moving={moving}
					onPickUp={setMoving}
					onDrop={onDropInto}
					onCancelMove={cancelMove}
					onReveal={() => {
						if (compact) setPanel('notebooks');
					}}
					newNotebookAsked={newNotebookAsked}
					openNotebooks={openNotebooks}
					onOpenNotebooks={onOpenNotebooks}
					onPinFolder={(path, pinned) => {
						if (activeConnection !== undefined)
							void setNotebookPinned(db, activeConnection, path, pinned);
					}}
				/>

				<NoteList
					notes={notes}
					renamings={renamings}
					selectedNoteId={noteId}
					onSelectNote={(id) => {
						select({ note: id });
						setPanel(null);
					}}
					onCreateNote={() => {
						onCreateNote();
						setPanel(null);
					}}
					onCreateNotebook={askNewNotebook}
					folderPath={folder}
					// Both queries, not just the tree: the notebooks alone cannot tell
					// an empty app from one whose notes all sit loose at the root.
					storeLoaded={tree !== undefined && looseNoteCount !== undefined}
					onPickUpNote={(note) => {
						setMoving({ kind: 'note', id: note.id, path: note.path, name: note.title });
					}}
					onCancelMove={cancelMove}
					movingNoteId={moving?.kind === 'note' ? moving.id : undefined}
					unsavedNoteId={unsavedNoteId}
					liveEdits={liveEdits}
					// The note's own menu, about the note on the row its `⋯` or
					// a right-click is on, which need not be the one open. Delete goes through the note pane,
					// which holds what autosave has not stored yet.
					pinnedNoteIds={pins?.notes}
					menuFor={(note) =>
						noteMenuItems({
							pinned: pins?.notes.has(note.id),
							onPin: () => {
								void setNotePinned(
									db,
									note.connectionId,
									note.id,
									pins?.notes.has(note.id) !== true
								);
							},
							onMove:
								moving === null
									? () => {
											pickUp({
												kind: 'note',
												id: note.id,
												path: note.path,
												name: note.title,
											});
										}
									: undefined,
							onDelete: () => {
								noteView.current?.deleteNote(note);
							},
						})
					}
				/>

				<NoteView
					ref={noteView}
					note={openNote}
					draft={place.noteDraft}
					liveEdits={liveEdits}
					renamings={renamings}
					onProblem={setProblem}
					{...emptyPaneOffers({
						folder,
						nothingYet: tree?.length === 0 && looseNoteCount === 0,
						onCreateNote,
						onCreateNotebook: askNewNotebook,
					})}
					// The next note along follows by itself: a tombstone is not a note
					// to show, so the one open last in the notebook, or its first,
					// takes its place (`useOpenPlace`).
					onDeleted={(note, displaced) => {
						setDeleted(note);
						setBeside(displaced ?? null);
					}}
				/>
			</div>

			{/*
			 * One stack for everything this screen floats over the page. Two
			 * notices at once is ordinary — a failed create while the account
			 * just connected is still being read — and in a stack they sit above
			 * one another instead of on one another.
			 *
			 * The undo notice is here rather than placing itself, which is what
			 * it did while it was the only other card on the screen.
			 */}
			<HeldImport source={held} />
			<TakeShare
				share={share}
				source={source}
				sources={sources}
				onRead={shareRead}
				onAdded={shareAdded}
			/>
			<div className="toast-stack">
				{deleted !== null && (
					<DeletedNotice
						// A second delete is a new notice with a new clock, not the
						// first one's time running on under another note's name.
						key={noteRef(deleted)}
						title={deleted.title}
						onUndo={undoDelete}
						onDismiss={dismissDeleted}
						keep={undoFailed === noteRef(deleted)}
					/>
				)}
				{connectNotice !== undefined && (
					<Toast
						message={connectNotice.message}
						tone={connectNotice.tone}
						action={connectNotice.action}
						onDismiss={dismissConnect}
					/>
				)}
				{problem !== null && (
					<Toast
						message={problem.message}
						tone={problem.tone}
						onDismiss={dismissProblem}
					/>
				)}
			</div>
		</div>
	);
};

/**
 * The provider wraps the shell rather than the app: every command belongs to a
 * mounted screen, so a registry with the same lifetime as the screen is one
 * that cannot hold a command whose `run` closes over a component that has gone.
 */
const HomeWithCommands = () => (
	<CommandsProvider>
		<Home />
	</CommandsProvider>
);

export const Route = createFileRoute('/')({
	validateSearch: parseSearch,
	component: HomeWithCommands,
	// Here as well as on the root so that the root's layout survives this screen
	// failing: the "new version" prompt lives there, and a build that throws on
	// render is exactly the one the user needs to be able to reload out of.
	errorComponent: ErrorScreen,
});
