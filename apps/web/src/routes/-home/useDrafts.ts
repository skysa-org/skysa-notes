import { parentPath } from '@skysa/core';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { NoteDraft } from '../../components/NoteView.js';
import { db, LOCAL_CONNECTION_ID, type NoteRecord } from '../../store/db.js';
import { keeping } from '../../store/keeping.js';
import { createNote, draftNote, setNoteEditorMode } from '../../store/notes.js';

/**
 * The note begun and not yet stored, if one is open (`draftNote`), and what the
 * note pane may do with it (`NoteDraft`).
 *
 * In memory and nowhere else until the user edits it: a keystroke in its body
 * or a name given to it stores it, as it is, and from then on it is a note like
 * any other. Left unedited it simply stops being open, and nothing was written
 * — not to the device, and so not to the user's folder either.
 */
export const useDrafts = ({
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
	/** Each draft is stored once, however many edits ask, and asked again where that failed. */
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
					storing.current.delete(note.id);
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
