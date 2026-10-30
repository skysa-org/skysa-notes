import { isWithin, rebasePath } from '@skysa/core';
import { useEffect } from 'react';

import { useShell } from '../../components/shell/context.js';
import { type Notice, useNotices } from '../../components/ui/notices.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import type { NoteRecord } from '../../store/db.js';
import {
	createFolder,
	deleteFolder,
	FolderExistsError,
	renameFolder,
} from '../../store/folders.js';
import type { Select } from './useOpenPlace.js';

/**
 * What a notebook the store refused says: its name taken, here or where it
 * was going, as a warning; anything else as `failed`, an error.
 */
export const notebookRefused = (error: unknown, taken: 'here' | 'there', failed: string): Notice =>
	error instanceof FolderExistsError
		? {
				message:
					taken === 'here'
						? t('shell.notebook.existsHere', { name: error.folderName })
						: t('shell.notebook.existsThere', { name: error.folderName }),
				tone: 'warning',
			}
		: { message: failed, tone: 'error' };

/**
 * Making, renaming and deleting a notebook from the sidebar, and keeping the
 * URL on the open notebook through a rename or a delete.
 */
export const useNotebookActions = ({
	folder,
	openNote,
	select,
	openFolder,
}: Readonly<{
	folder: string | undefined;
	openNote: NoteRecord | undefined;
	select: Select;
	openFolder: (path: string) => void;
}>) => {
	const db = useDb();
	// A notebook's new name, being typed: the shell's, which the home route is drawn in.
	const { renamings } = useShell();
	const { say, moveOn } = useNotices();
	const onCreateFolder = (parentPath: string | undefined, name: string) => {
		// `createFolder` throws on a duplicate name, and the field has already
		// closed by the time it does: without this the user types a name, presses
		// Enter, and nothing whatsoever happens — plus an unhandled rejection.
		moveOn();
		void createFolder(db, { parentPath, name })
			.then((created) => {
				openFolder(created.path);
			})
			.catch((error: unknown) => {
				say(notebookRefused(error, 'here', t('shell.notebook.notMade')));
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
		moveOn();
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
					select({ folder: rebasePath(folder, path, to) }, { replace: true });
				}
			})
			.catch((error: unknown) => {
				say(notebookRefused(error, 'here', t('shell.notebook.notRenamed')));
			});
	};

	const onDeleteFolder = (path: string) => {
		moveOn();
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
					select(
						{
							...(goneFolder ? { folder: undefined } : {}),
							...(goneNote ? { note: undefined } : {}),
						},
						{ replace: true }
					);
				}
			})
			.catch(() => {
				say({ message: t('shell.notebook.notDeleted'), tone: 'error' });
			});
	};

	return { onCreateFolder, onRenameFolder, onDeleteFolder };
};
