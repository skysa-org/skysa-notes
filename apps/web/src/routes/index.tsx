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
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client.js';
import { answer, useInstanceConfig } from '../api/instanceConfig.js';
import { parseChord } from '../commands/chord.js';
import { CommandsProvider, useCommand, useShortcuts } from '../commands/context.js';
import { AccountPanel, returnPath } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { CompactBar, useCompactLayout } from '../components/CompactBar.js';
import { DeletedNotice } from '../components/DeletedNotice.js';
import { ErrorScreen } from '../components/ErrorScreen.js';
import { HeldImport } from '../components/ImportProgress.js';
import { NoteList } from '../components/NoteList.js';
import { noteMenuItems } from '../components/noteMenu.js';
import { type DisplacedText, NoteView, type NoteViewHandle } from '../components/NoteView.js';
import { SearchField } from '../components/SearchField.js';
import { Sidebar } from '../components/Sidebar.js';
import { SourcePanel, SourceTabs } from '../components/SourceTabs.js';
import { Toast, type ToastAction, type ToastTone } from '../components/Toast.js';
import { showConnection } from '../store/connection.js';
import {
	activeConnectionId,
	db,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	noteRef,
	type SyncStateRecord,
} from '../store/db.js';
import { downloadProblem, downloadSource, INCOMPLETE_DOWNLOAD } from '../store/exportNotes.js';
import {
	createFolder,
	deleteFolder,
	FolderExistsError,
	moveFolder,
	renameFolder,
} from '../store/folders.js';
import {
	useActiveConnectionId,
	useActiveSource,
	useClaimingConnection,
	useFolderTree,
	useHeldImport,
	useLooseNoteCount,
	useNote,
	useNoteSearch,
	useNotesInFolder,
	useSources,
} from '../store/hooks.js';
import { keeping } from '../store/keeping.js';
import { createNote, listNotes, moveNote, saveNoteBody, undeleteNote } from '../store/notes.js';
import { dropMove, type Moving } from '../store/rearrange.js';
import { selectedFolderPath } from '../store/tree.js';
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
 * component state, so reloading, going back, or reopening the PWA lands the user
 * where they were.
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
 */
const connectMessage = (
	outcome: ConnectOutcome,
	code?: EntitlementCode,
	gate?: ConnectGate
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
				message: `${refusedMessage(code)}, so storage was not connected.`,
				tone: 'error',
				action: gate?.action,
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
 * storage panel a wide window keeps under the notebooks, and the way to
 * another account.
 */
const SourceDropdown = ({
	compact,
	returnTo,
	onChosen,
}: {
	compact: boolean;
	returnTo: string;
	onChosen: () => void;
}) =>
	compact ? (
		<SourcePanel
			returnTo={returnTo}
			account={<AccountPanel connectIs="below" />}
			onChosen={onChosen}
		/>
	) : null;

/**
 * Picking the open note up to move it, from the palette or from the note's
 * own menu — offered in both only while nothing else is in the air. What it
 * returns is spread onto `NoteView`, which offers the move when it is there.
 */
const useNoteMove = (
	openNote: NoteRecord | undefined,
	moving: Moving | null,
	pickUp: (what: Moving) => void
): { onMove?: () => void } => {
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

	return offered ? { onMove: move } : {};
};

/**
 * The source showing, whole, as an archive of markdown (docs/ARCHITECTURE.md
 * §7, "Getting a library out"). For a device with nothing connected it is the
 * one copy of the notes that can leave this browser; for a source that syncs it
 * is what this device holds of its folder, without a trip to the provider's
 * own client. Unavailable while the source holds nothing, which would be an
 * empty archive, and while a later source's first import is still filling it,
 * which would be whatever part had arrived under a name that says "all" — the
 * storage panel holds its button back then too.
 */
const useDownloadCommand = ({
	connectionId,
	source,
	notebooks = 0,
	looseNotes = 0,
	onProblem,
}: {
	connectionId: string | undefined;
	/** The source showing: `null` for the device's own, `undefined` until read. */
	source: SyncStateRecord | null | undefined;
	/** How many notebooks are at the top of the source; every other note is in one. */
	notebooks: number | undefined;
	looseNotes: number | undefined;
	onProblem: (notice: Notice) => void;
}) => {
	useCommand({
		id: 'app.download',
		label: 'Download all notes',
		group: 'App',
		enabled:
			connectionId !== undefined &&
			source?.importing === undefined &&
			notebooks + looseNotes > 0,
		run: () => {
			if (connectionId === undefined) return;
			void downloadSource(db, connectionId)
				.then(({ incomplete }) => {
					if (incomplete) onProblem({ message: INCOMPLETE_DOWNLOAD, tone: 'warning' });
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
 * The toast for how a connect went, read once as the app opens on the way back
 * from the provider and taken out of the URL straight away: left there, a
 * reload or a bookmark would say "connected" again about a connection that may
 * since have gone.
 *
 * Except that a first source's "connected" is the import dialog's to say, and
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
	// The operator's gate, whose action is the one thing a refused toast can
	// offer to do. The same request the connect buttons make (`instanceConfig`).
	const gate = answer(useInstanceConfig(api))?.connectGate;
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
	const waiting = outcome === 'ok' && (claiming || held !== undefined);
	const connectNotice =
		outcome === undefined || waiting ? undefined : connectMessage(outcome, refusedAs, gate);
	return { connectNotice, dismissConnect };
};

const Home = () => {
	const { folder: requestedFolder, note: noteId, connect, code } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	// Where a connect started from the tab bar should come back to.
	const href = useRouterState({ select: (state) => state.location.href });

	const source = useActiveSource();
	// The first source's import holds the app: the device's notes are being
	// moved into it, and nothing may be done to them until it is through.
	const held = useHeldImport();
	const { connectNotice, dismissConnect } = useConnectNotice(connect, code, held);
	const activeConnection = useActiveConnectionId();
	const sources = useSources();
	const tree = useFolderTree();
	const looseNoteCount = useLooseNoteCount();
	// Derived rather than written back to the URL: the URL records the user's
	// choice, and opening the first notebook is a default, not a choice. Writing
	// it would also mean redirecting from an effect on the very first render.
	const folder = selectedFolderPath(tree, folderFromSearch(requestedFolder), looseNoteCount);
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);
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
	const { compact, panel, setPanel, searchOpen, setSearchOpen, frameClassName, shellProps } =
		useCompactLayout();
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

	/**
	 * Why the last thing the user asked for did not happen. Creating a notebook
	 * or a note can reject — a duplicate name is the everyday case — and by then
	 * the name field has closed and the click is over, so without somewhere to
	 * put this the user acts and the app shows nothing at all.
	 */
	const [problem, setProblem] = useState<Notice | null>(null);

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
	 * a notebook inside it, at any depth. Clicking a parent of the note's own
	 * notebook used to clear it and leave an empty editor beside a list, which
	 * was the reported bug. Anywhere else, the notebook's most recent note is
	 * opened instead, so a notebook with notes in it is never a blank pane.
	 *
	 * The root is not a notebook: its row lists what sits loose in it, and a
	 * note in any notebook is under the root without being one of those.
	 *
	 * The notebook switches at once and the note follows once the store has
	 * answered, rather than the click waiting on a read. The follow-up looks at
	 * the URL as it is by then, not as it was at the click: the user may have
	 * clicked another notebook, or a note, in between, and the note this click
	 * found belongs to neither of those choices.
	 */
	const openFolder = (path: string) => {
		const keep =
			openNote !== undefined &&
			(path === ROOT ? parentPath(openNote.path) === ROOT : isWithin(openNote.path, path));
		if (keep) {
			select({ folder: folderToSearch(path) });
			return;
		}
		openFirstNoteIn(path);
	};

	/**
	 * Show `path` with nothing open, then open its most recent note once the
	 * store has said which that is. Used by a click on a notebook the open
	 * note is not in, and by a delete, which is the other way a notebook comes
	 * to be showing with nothing open beside a list with something in it.
	 */
	const openFirstNoteIn = (path: string) => {
		const wanted = folderToSearch(path);
		select({ folder: wanted, note: undefined });
		void listNotes(db, { folderPath: path }).then(([first]) => {
			if (first === undefined) return;
			void navigate({
				search: (current) =>
					current.folder === wanted && current.note === undefined
						? { ...current, note: first.id }
						: current,
				replace: true,
			});
		});
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
		const go = () => {
			select({ folder: folderToSearch(parentPath(note.path)), note: note.id });
		};
		if (note.connectionId === activeConnection) {
			go();
			return;
		}
		void showConnection(db, note.connectionId).then((shown) => {
			if (shown) go();
		});
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

	const onCreateNote = () => {
		// The root holds loose notes that arrived from the remote folder; the app
		// does not add to them (docs/ARCHITECTURE.md §12.6).
		if (folder === undefined || folder === ROOT) return;
		setProblem(null);
		void createNote(db, { folderPath: folder })
			.then((created) => {
				select({ note: created.id });
				// A note in the device's own library exists nowhere else, and this
				// was a click: the moment the browser can be asked to keep it,
				// prompt and all, once per device (`store/keeping.ts`).
				if (created.connectionId === LOCAL_CONNECTION_ID) {
					void keeping.ask(db, 'first-note');
				}
			})
			// Rarer than a duplicate notebook name — this one needs the store
			// itself to refuse — but the same silence if it happens: the button
			// does nothing and the failure goes to the console.
			.catch(() => {
				setProblem({ message: 'That note could not be made.', tone: 'error' });
			});
	};

	const onCreateFolder = (parentPath: string | undefined, name: string) => {
		// `createFolder` throws on a duplicate name, and the field has already
		// closed by the time it does: without this the user types a name, presses
		// Enter, and nothing whatsoever happens — plus an unhandled rejection.
		setProblem(null);
		void createFolder(db, { parentPath, name })
			.then((created) => {
				select({ folder: folderToSearch(created.path) });
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

	const onRenameFolder = (path: string, name: string) => {
		setProblem(null);
		void renameFolder(db, path, name)
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
			void moveNote(db, move.id, move.into)
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

	useDownloadCommand({
		connectionId: activeConnection,
		source,
		notebooks: tree?.length,
		looseNotes: looseNoteCount,
		onProblem: setProblem,
	});

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

	const noteMove = useNoteMove(openNote, moving, pickUp);
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
				/>
			) : (
				<SourceTabs
					returnTo={returnPath(href)}
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
					returnTo={returnPath(href)}
					onChosen={() => {
						setPanel(null);
					}}
				/>
				<Sidebar
					tree={tree}
					selectedFolder={folder}
					onSelectFolder={(path) => {
						openFolder(path);
						setPanel(null);
					}}
					onCreateFolder={onCreateFolder}
					onRenameFolder={onRenameFolder}
					onDeleteFolder={onDeleteFolder}
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
				/>

				<NoteList
					notes={notes}
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
					// The note's own menu, about the note right-clicked, which
					// need not be the one open. Delete goes through the note pane,
					// which holds what autosave has not stored yet.
					menuFor={(note) =>
						noteMenuItems({
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
					{...noteMove}
					{...emptyPaneOffers({
						folder,
						nothingYet: tree?.length === 0 && looseNoteCount === 0,
						onCreateNote,
						onCreateNotebook: askNewNotebook,
					})}
					onDeleted={(note, displaced) => {
						setDeleted(note);
						setBeside(displaced ?? null);
						// The delete waits for what autosave had out, and the user
						// may have opened another note by the time it is done.
						if (noteIdRef.current !== note.id) return;
						// The next note along rather than an empty pane, while the
						// notebook has one: the tombstone is in the row by now, so
						// the read leaves the deleted note out.
						if (folder === undefined) {
							select({ note: undefined });
							return;
						}
						openFirstNoteIn(folder);
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
