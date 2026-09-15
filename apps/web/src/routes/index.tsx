import { ROOT } from '@skysa/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { NoteList } from '../components/NoteList.js';
import { NoteView } from '../components/NoteView.js';
import { Sidebar } from '../components/Sidebar.js';
import { db } from '../store/db.js';
import { createFolder } from '../store/folders.js';
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
	const folder = selectedFolderPath(
		tree,
		folderFromSearch(requestedFolder),
		looseNoteCount !== undefined && looseNoteCount > 0
	);
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);

	const select = (next: Partial<AppSearch>) => {
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
		void createFolder(db, { parentPath, name }).then((created) => {
			select({ folder: folderToSearch(created.path) });
		});
	};

	return (
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
				notebooksLoaded={tree !== undefined}
			/>

			<NoteView
				note={openNote}
				onDeleted={() => {
					select({ note: undefined });
				}}
			/>
		</div>
	);
};

export const Route = createFileRoute('/')({
	validateSearch: parseSearch,
	component: Home,
});
