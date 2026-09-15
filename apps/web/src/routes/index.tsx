import { ROOT } from '@skysa/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { NoteList } from '../components/NoteList.js';
import { NoteView } from '../components/NoteView.js';
import { Sidebar } from '../components/Sidebar.js';
import { db } from '../store/db.js';
import { createFolder, FolderExistsError } from '../store/folders.js';
import { useFolderTree, useLooseNoteCount, useNote, useNotesInFolder } from '../store/hooks.js';
import { createNote } from '../store/notes.js';
import { selectedFolderPath } from '../store/tree.js';
import { type AppSearch, folderFromSearch, folderToSearch, parseSearch } from './search.js';

/**
 * The app. Which folder and note are open lives in the URL rather than in
 * component state, so reloading, going back, or reopening the PWA lands the user
 * where they were.
 */

const Home = () => {
	const { folder: requestedFolder, note: noteId } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	const tree = useFolderTree();
	const looseNoteCount = useLooseNoteCount();
	// Derived rather than written back to the URL: the URL records the user's
	// choice, and opening the first notebook is a default, not a choice. Writing
	// it would also mean redirecting from an effect on the very first render.
	const folder = selectedFolderPath(tree, folderFromSearch(requestedFolder), looseNoteCount);
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);

	/**
	 * Why the last notebook could not be made. `createFolder` rejects on a
	 * duplicate name, and the field has already closed by then, so without
	 * somewhere to put this the user types a name, presses Enter, and nothing
	 * whatsoever happens.
	 */
	const [folderError, setFolderError] = useState<string | null>(null);

	const select = (next: Partial<AppSearch>) => {
		// Anything else the user does answers the banner: it is about the name they
		// just tried, not about the app, and leaving it up means a message about a
		// notebook they have since moved on from sits there for the session.
		setFolderError(null);
		void navigate({ search: (current) => ({ ...current, ...next }), replace: true });
	};

	const onCreateNote = () => {
		// The root holds loose notes that arrived from the remote folder; the app
		// does not add to them (docs/PLAN.md §12.6).
		if (folder === undefined || folder === ROOT) return;
		void createNote(db, { folderPath: folder }).then((created) => {
			select({ note: created.id });
		});
	};

	const onCreateFolder = (parentPath: string | undefined, name: string) => {
		// `createFolder` throws on a duplicate name, and the field has already
		// closed by the time it does: without this the user types a name, presses
		// Enter, and nothing whatsoever happens — plus an unhandled rejection.
		setFolderError(null);
		void createFolder(db, { parentPath, name })
			.then((created) => {
				select({ folder: folderToSearch(created.path) });
			})
			.catch((error: unknown) => {
				setFolderError(
					error instanceof FolderExistsError
						? `There is already a notebook called “${error.folderName}” here.`
						: 'That notebook could not be made.'
				);
			});
	};

	return (
		// `app-shell` is a three-column grid with exactly three children. A banner
		// put inside it becomes a fourth grid item, takes the sidebar's column and
		// pushes the note view into a clipped second row, so anything that sits
		// above the panes goes in the frame around them instead.
		<div className="app-frame">
			{folderError !== null && (
				<p className="banner" role="alert">
					{folderError}
				</p>
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
				/>

				<NoteList
					notes={notes}
					selectedNoteId={noteId}
					onSelectNote={(id) => {
						select({ note: id });
					}}
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

export const Route = createFileRoute('/')({
	validateSearch: parseSearch,
	component: Home,
});
