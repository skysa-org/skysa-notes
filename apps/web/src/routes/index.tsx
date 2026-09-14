import { ROOT } from '@skysa/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { NoteList } from '../components/NoteList.js';
import { NoteView } from '../components/NoteView.js';
import { Sidebar } from '../components/Sidebar.js';
import { db } from '../store/db.js';
import { createFolder } from '../store/folders.js';
import { useFolderTree, useNote, useNotesInFolder } from '../store/hooks.js';
import { createNote } from '../store/notes.js';

/**
 * The app. Which folder and note are open lives in the URL rather than in
 * component state, so reloading, going back, or reopening the PWA lands the user
 * where they were.
 */

export interface AppSearch {
	folder: string;
	note?: string;
}

const Home = () => {
	const { folder, note: noteId } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	const tree = useFolderTree();
	const notes = useNotesInFolder(folder);
	const openNote = useNote(noteId);
	const rootNotes = useNotesInFolder(ROOT);

	const select = (next: Partial<AppSearch>) => {
		void navigate({ search: (current) => ({ ...current, ...next }), replace: true });
	};

	const onCreateNote = () => {
		void createNote(db, { folderPath: folder }).then((created) => {
			select({ note: created.id });
		});
	};

	const onCreateFolder = (parentPath: string, name: string) => {
		void createFolder(db, { parentPath, name }).then((created) => {
			select({ folder: created.path });
		});
	};

	return (
		<div className="app-shell">
			<Sidebar
				tree={tree}
				selectedFolder={folder}
				onSelectFolder={(path) => {
					select({ folder: path, note: undefined });
				}}
				onCreateFolder={onCreateFolder}
				rootNoteCount={rootNotes?.length ?? 0}
			/>

			<NoteList
				notes={notes}
				selectedNoteId={noteId}
				onSelectNote={(id) => {
					select({ note: id });
				}}
				onCreateNote={onCreateNote}
				folderLabel={folder === ROOT ? 'All notes' : folder}
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
	validateSearch: (search: Record<string, unknown>): AppSearch => ({
		folder: typeof search.folder === 'string' ? search.folder : ROOT,
		...(typeof search.note === 'string' && search.note !== '' ? { note: search.note } : {}),
	}),
	component: Home,
});
