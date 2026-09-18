import { parentPath, ROOT } from '@skysa/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { parseChord } from '../commands/chord.js';
import { CommandsProvider, useCommand, useShortcuts } from '../commands/context.js';
import { AccountPanel } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { NoteList } from '../components/NoteList.js';
import { NoteView } from '../components/NoteView.js';
import { Sidebar } from '../components/Sidebar.js';
import { db } from '../store/db.js';
import { createFolder, FolderExistsError } from '../store/folders.js';
import {
	useFolderTree,
	useLooseNoteCount,
	useNote,
	useNoteSearch,
	useNotesInFolder,
} from '../store/hooks.js';
import { createNote } from '../store/notes.js';
import { selectedFolderPath } from '../store/tree.js';
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
 * The `default` is not dead code, which is the whole reason it is written out.
 * `validateSearch` is supposed to have dropped anything not in
 * `CONNECT_OUTCOMES` before this is reached, and at runtime it does not — a
 * hand-typed or bookmarked `?connect=signin` arrives here intact. Without the
 * default this returned `undefined` through a `string` signature and the app
 * rendered an **empty** alert banner: a red bar saying nothing, which is worse
 * than either showing the message or showing nothing at all.
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

	const tree = useFolderTree();
	const looseNoteCount = useLooseNoteCount();
	// Derived rather than written back to the URL: the URL records the user's
	// choice, and opening the first notebook is a default, not a choice. Writing
	// it would also mean redirecting from an effect on the very first render.
	const folder = selectedFolderPath(tree, folderFromSearch(requestedFolder), looseNoteCount);
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);

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
					onDeleted={() => {
						select({ note: undefined });
					}}
				/>
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
});
