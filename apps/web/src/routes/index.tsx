import { parentPath, ROOT } from '@skysa/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { parseChord } from '../commands/chord.js';
import { CommandsProvider, useCommand, useShortcuts } from '../commands/context.js';
import { AccountPanel } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { DeletedNotice } from '../components/DeletedNotice.js';
import { ErrorScreen } from '../components/ErrorScreen.js';
import { NoteList } from '../components/NoteList.js';
import { type DisplacedText, NoteView } from '../components/NoteView.js';
import { Sidebar } from '../components/Sidebar.js';
import { activeConnectionId, db, type NoteRecord, noteRef } from '../store/db.js';
import { createFolder, FolderExistsError } from '../store/folders.js';
import {
	useActiveSource,
	useFolderTree,
	useLooseNoteCount,
	useNote,
	useNoteSearch,
	useNotesInFolder,
} from '../store/hooks.js';
import { createNote, saveNoteBody, undeleteNote } from '../store/notes.js';
import { selectedFolderPath } from '../store/tree.js';
import { sourceName } from '../sync/account.js';
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
const connectMessage = (outcome: ConnectOutcome): string | undefined => {
	switch (outcome) {
		case 'ok':
			return 'Storage connected. Your notes will sync with it.';
		case 'denied':
			return 'Connecting storage was cancelled.';
		case 'failed':
			return 'The storage account could not be connected. Try again.';
		case 'partial':
			return 'Access to your files was not granted, so storage was not connected. Connect again and leave that permission ticked.';
		case 'refused':
			return 'This account cannot sync on this server, so storage was not connected.';
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

const Home = () => {
	const { folder: requestedFolder, note: noteId, connect } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	// Read once, as the app opens on the way back from the provider, and taken
	// out of the URL straight away: left there, a reload or a bookmark would say
	// "connected" again about a connection that may since have gone.
	const [connectOutcome, setConnectOutcome] = useState(connect);
	useEffect(() => {
		if (connect === undefined) return;
		void navigate({
			search: ({ connect: _outcome, ...rest }) => rest,
			replace: true,
		});
	}, [connect, navigate]);

	const source = useActiveSource();
	const tree = useFolderTree();
	const looseNoteCount = useLooseNoteCount();
	// Derived rather than written back to the URL: the URL records the user's
	// choice, and opening the first notebook is a default, not a choice. Writing
	// it would also mean redirecting from an effect on the very first render.
	const folder = selectedFolderPath(tree, folderFromSearch(requestedFolder), looseNoteCount);
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);
	// Read by a continuation that finishes after the user may have moved on.
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
	const [problem, setProblem] = useState<string | null>(null);

	const select = (next: Partial<AppSearch>) => {
		// Anything else the user does answers the banner: it is about the name they
		// just tried, not about the app, and leaving it up means a message about a
		// notebook they have since moved on from sits there for the session.
		setProblem(null);
		setConnectOutcome(undefined);
		void navigate({ search: (current) => ({ ...current, ...next }), replace: true });
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
					setProblem(
						home?.detached === undefined
							? `“${restored.title}” is back, in the source it was deleted from.`
							: `“${restored.title}” is back, in ${sourceName(home) ?? 'its source'}, which is disconnected. Reconnect it, or download the note.`
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
				setProblem('That note could not be brought back. Try again.');
			});
	};

	const onCreateNote = () => {
		// The root holds loose notes that arrived from the remote folder; the app
		// does not add to them (docs/PLAN.md §12.6).
		if (folder === undefined || folder === ROOT) return;
		setProblem(null);
		void createNote(db, { folderPath: folder })
			.then((created) => {
				// And out of the search: the new note is in the open notebook, and
				// the pane is showing matches for a query it does not answer. Left
				// there, the user has just made a note that appears in no list.
				setQuery('');
				select({ note: created.id });
			})
			// Rarer than a duplicate notebook name — this one needs the store
			// itself to refuse — but the same silence if it happens: the button
			// does nothing and the failure goes to the console.
			.catch(() => {
				setProblem('That note could not be made.');
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
						? `There is already a notebook called “${error.folderName}” here.`
						: 'That notebook could not be made.'
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
		// is open (docs/PLAN.md §12.6).
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
			searchField.current?.focus();
			searchField.current?.select();
		},
	});

	useCommand({
		id: 'note.undoDelete',
		label: 'Undo delete',
		group: 'Note',
		enabled: deleted !== null,
		run: undoDelete,
	});

	useShortcuts();

	return (
		// `app-shell` is a three-column grid with exactly three children. A banner
		// put inside it becomes a fourth grid item, takes the sidebar's column and
		// pushes the note view into a clipped second row, so anything that sits
		// above the panes goes in the frame around them instead.
		<div className="app-frame">
			{problem !== null && (
				<p className="banner" role="alert">
					{problem}
				</p>
			)}
			{connectOutcome !== undefined && connectMessage(connectOutcome) !== undefined && (
				<p className="banner" role={connectOutcome === 'ok' ? 'status' : 'alert'}>
					{connectMessage(connectOutcome)}
				</p>
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
					{sourceName(source) ?? 'This source'} is disconnected. The notes here were never
					sent to it, and nothing written here is synced. Reconnect it, or download or
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

			<div className="app-shell">
				<Sidebar
					tree={tree}
					selectedFolder={folder}
					onSelectFolder={(path) => {
						select({ folder: folderToSearch(path), note: undefined });
					}}
					onCreateFolder={onCreateFolder}
					looseNoteCount={looseNoteCount}
					footer={<AccountPanel />}
				/>

				<NoteList
					notes={notes}
					selectedNoteId={noteId}
					onSelectNote={(id) => {
						// A result can be in any notebook, and opening one has to
						// take the user there: left in the notebook they were in,
						// the sidebar would highlight one notebook while the note
						// beside it came from another, and clearing the search would
						// leave the open note nowhere in the list.
						const hit = results?.find((each) => each.note.id === id);
						select(
							hit === undefined
								? { note: id }
								: {
										note: id,
										folder: folderToSearch(parentPath(hit.note.path)),
									}
						);
					}}
					query={query}
					onQuery={setQuery}
					queryRef={searchField}
					results={results}
					onCreateNote={onCreateNote}
					folderPath={folder}
					// Both queries, not just the tree: the notebooks alone cannot tell
					// an empty app from one whose notes all sit loose at the root.
					storeLoaded={tree !== undefined && looseNoteCount !== undefined}
				/>

				<NoteView
					note={openNote}
					onDeleted={(note, displaced) => {
						setDeleted(note);
						setBeside(displaced ?? null);
						// The delete waits for what autosave had out, and the user
						// may have opened another note by the time it is done.
						if (noteIdRef.current === note.id) select({ note: undefined });
					}}
				/>
			</div>

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
