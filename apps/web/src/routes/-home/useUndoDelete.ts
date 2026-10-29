import { isScratchPath, SCRATCHPAD_FOLDER, VAULT_FOLDER } from '@skysa/core';
import { type RefObject, useCallback, useState } from 'react';

import type { DisplacedText } from '../../components/note/types.js';
import type { Notice } from '../../components/notify.js';
import { t } from '../../i18n/t.js';
import { activeConnectionId, db, type NoteRecord, noteRef } from '../../store/db.js';
import { deleteNote, getNote, saveNoteBody, undeleteNote } from '../../store/notes.js';
import { nameShown } from '../../store/titles.js';
import { sourceName } from '../../sync/account.js';
import { placeFolder } from '../place.js';
import type { Select } from './useOpenPlace.js';

/**
 * A deleted note brought back into a source that has been disconnected, which
 * is said by name where it has one (`sourceName`).
 */
const backDisconnected = (title: string, source: string | undefined): string =>
	source === undefined
		? t('shell.note.backDisconnectedUnnamed', { title })
		: t('shell.note.backDisconnected', { title, source });

/**
 * The note just deleted, as it was, for as long as the delete can be taken
 * back. Here rather than in `NoteView`, which stops showing a note the moment
 * it is a tombstone. One at a time: a second delete takes the notice over and
 * the first note simply stays deleted.
 */
export const useUndoDelete = ({
	select,
	setProblem,
	noteIdRef,
}: Readonly<{
	select: Select;
	setProblem: (notice: Notice | null) => void;
	/** The note open now, read once a delete has gone through. */
	noteIdRef: Readonly<RefObject<string | undefined>>;
}>) => {
	const [deleted, setDeleted] = useState<NoteRecord | null>(null);
	/** The note (`noteRef`) whose undo failed: its notice waits to be dismissed. */
	const [undoFailed, setUndoFailed] = useState<string | null>(null);
	/** Text that goes back beside the deleted note, not into it (`NoteView`). */
	const [beside, setBeside] = useState<DisplacedText | null>(null);
	const dismissDeleted = useCallback(() => {
		setDeleted(null);
	}, []);
	/** A note just deleted, with the text that goes back beside it, if any. */
	const noteDeleted = useCallback((note: NoteRecord, displaced?: DisplacedText) => {
		setDeleted(note);
		setBeside(displaced ?? null);
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
									message: t('shell.note.back', {
										title: nameShown(restored),
									}),
									tone: 'success',
								}
							: {
									message: backDisconnected(
										nameShown(restored),
										sourceName(home)
									),
									tone: 'warning',
								}
					);
					return;
				}
				// Back where it was, open. By the row's own path, not the one it
				// was deleted at: once sync has purged the row the note is made
				// again, under a conflict name if something took the old one. A
				// scratch note is back on the wall, its card not opened over it,
				// and a password in the passwords, however deep in their folder.
				select(
					isScratchPath(restored.path)
						? { folder: SCRATCHPAD_FOLDER, note: undefined }
						: { note: restored.id, folder: placeFolder(restored.path) },
					{ replace: true, note: restored }
				);
			})
			// The notice stays, and for as long as it takes: the note is still
			// deleted, still offered, and what it holds may be in no other place.
			.catch(() => {
				setUndoFailed(noteRef(deleted));
				setProblem({
					message: t('shell.note.notBack'),
					tone: 'error',
				});
			});
	};

	/**
	 * Delete a password, taken away at once with the notice's undo, as a note
	 * is; the list is what shows in its place.
	 */
	const deletePassword = (note: NoteRecord) => {
		const home = { connectionId: note.connectionId };
		void deleteNote(db, note.id, home)
			.then(() => getNote(db, note.id, home).catch(() => undefined))
			.then((row) => {
				noteDeleted(row ?? note);
				if (noteIdRef.current === note.id) {
					select({ folder: VAULT_FOLDER, note: undefined }, { replace: true });
				}
			})
			.catch(() => {
				setProblem({ message: t('passwords.item.notDeleted'), tone: 'error' });
			});
	};

	return {
		deleted,
		noteDeleted,
		undoFailed,
		dismissDeleted,
		undoDelete,
		deletePassword,
	};
};
