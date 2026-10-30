import { parentPath } from '@skysa/core';

import { NoteList, type NoteListProps } from '../../components/list/NoteList.js';
import { noteMenuItems } from '../../components/list/noteMenu.js';
import { useDb } from '../../store/database.js';
import type { NoteRecord } from '../../store/db.js';
import { setNotePinned } from '../../store/pins.js';
import type { Moving } from '../../store/rearrange.js';
import { movingNote } from '../../store/titles.js';
import type { Select } from './useOpenPlace.js';

/**
 * The notes of the notebook open, in the middle column (`NoteList`), with
 * each row's own menu: pin, move and delete.
 */
export const NotesPane = ({
	notes,
	renamings,
	selectedNoteId,
	folderPath,
	select,
	onCreateNote,
	onCreateNotebook,
	storeLoaded,
	setMoving,
	cancelMove,
	moving,
	pickUp,
	unsavedNoteId,
	liveEdits,
	pins,
	deleteNote,
}: Readonly<
	Pick<
		NoteListProps,
		| 'notes'
		| 'renamings'
		| 'selectedNoteId'
		| 'folderPath'
		| 'onCreateNote'
		| 'onCreateNotebook'
		| 'storeLoaded'
		| 'unsavedNoteId'
		| 'liveEdits'
	> & {
		select: Select;
		/** Put a note in the air from its row, as a drag does (`useMoving`). */
		setMoving: (moving: Moving) => void;
		cancelMove: () => void;
		moving: Moving | null;
		/** Pick a note up from its menu (`useMoving`). */
		pickUp: (what: Moving) => void;
		pins: { notes: ReadonlySet<string> } | undefined;
		/** Delete through the note pane, which holds what autosave has not stored yet. */
		deleteNote: (note: NoteRecord) => void;
	}
>) => {
	const db = useDb();
	return (
		<NoteList
			notes={notes}
			renamings={renamings}
			selectedNoteId={selectedNoteId}
			// A note listed from a notebook inside the open one opens that
			// notebook with it, as a search result does: the sidebar then
			// lights the notebook the note is in.
			// Each a step with no dropdown over it, which shuts the notes.
			onSelectNote={(note) => {
				select({ folder: parentPath(note.path), note: note.id }, { note });
			}}
			onCreateNote={onCreateNote}
			onCreateNotebook={onCreateNotebook}
			folderPath={folderPath}
			storeLoaded={storeLoaded}
			onPickUpNote={(note) => {
				setMoving(movingNote(note));
			}}
			onCancelMove={cancelMove}
			movingNoteId={moving?.kind === 'note' ? moving.id : undefined}
			unsavedNoteId={unsavedNoteId}
			liveEdits={liveEdits}
			// The note's own menu, about the note on the row its `⋯` or
			// a right-click is on, which need not be the one open.
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
									pickUp(movingNote(note));
								}
							: undefined,
					onDelete: () => {
						deleteNote(note);
					},
				})
			}
		/>
	);
};
