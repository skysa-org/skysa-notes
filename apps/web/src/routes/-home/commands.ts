import { basename } from '@skysa/core';
import { useNavigate } from '@tanstack/react-router';
import { type RefObject, useEffect, useState } from 'react';

import { parseChord } from '../../commands/chord.js';
import { useCommand } from '../../commands/context.js';
import { type Notice } from '../../components/notify.js';
import { t } from '../../i18n/t.js';
import { db, type NoteRecord, type SyncStateRecord } from '../../store/db.js';
import { downloadNotice, downloadProblem, downloadSource } from '../../store/exportNotes.js';
import { useHoldsAnything } from '../../store/hooks.js';
import { keeping } from '../../store/keeping.js';
import { type Moving } from '../../store/rearrange.js';
import { titleShown } from '../../store/titles.js';
import { type AppSearch } from '../search.js';
import { canMakeNote, isNotebook } from './rules.js';

/**
 * The shell's chords and commands, and the URL arrivals the shell answers
 * that need no more of it than what they are handed: a code to enter, a note
 * to move, a source to download, and keeping the store on install.
 */

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
 * `?enter=code`, from an operator's page once the user has a code: the way to
 * connect storage, opened at the gate's code field. Counted, so that each
 * arrival opens it once (`useAdding` in `SourceTabs.tsx`), and taken out of
 * the URL at once, so that a reload does not open it again. In a compact
 * window the `+` is in the sources dropdown, which opens first.
 */
export const useEnterCode = (enter: AppSearch['enter'], compact: boolean): number => {
	const navigate = useNavigate({ from: '/' });
	const [asked, setAsked] = useState(0);
	// Counted in render, as React has state follow a prop: the URL arriving
	// with it is the change, and the effect below takes it out again.
	const [seen, setSeen] = useState<AppSearch['enter']>();
	if (enter !== seen) {
		setSeen(enter);
		if (enter !== undefined) setAsked(asked + 1);
	}
	useEffect(() => {
		if (enter === undefined) return;
		void navigate({
			search: ({ enter: _enter, ...rest }) => rest,
			// Where the user is stays as it was (`place.ts`), with the sources
			// open over it in one step, not a second after it (`usePanel`).
			hash: true,
			state: (held) => (compact ? { ...held, panel: 'sources' } : held),
			replace: true,
		});
	}, [enter, compact, navigate]);
	return asked;
};

/**
 * Picking the open note up to move it, from the palette — offered only while
 * nothing else is in the air. The note's menu offers it through `menuFor`, as
 * a right-click on its row does.
 */
const useNoteMove = (
	openNote: NoteRecord | undefined,
	moving: Moving | null,
	pickUp: (what: Moving) => void,
	/** A scratch note's way into a notebook, which names it first (`useScratchpad`). */
	promote: ((note: NoteRecord) => void) | undefined
): void => {
	const offered = openNote !== undefined && moving === null;
	const move = () => {
		if (openNote === undefined) return;
		if (promote !== undefined) {
			promote(openNote);
			return;
		}
		pickUp({
			kind: 'note',
			id: openNote.id,
			path: openNote.path,
			name: titleShown(openNote.title),
		});
	};

	useCommand({
		id: 'note.move',
		label: t('shell.commands.moveNote'),
		group: t('shell.commands.group.note'),
		enabled: offered,
		run: move,
	});
};

/**
 * The source showing, whole, as an archive of markdown (docs/ARCHITECTURE.md
 * §7, "Getting a library out"). For a device with nothing connected it is the
 * one copy of the notes that can leave this browser; for a source that syncs it
 * is what this device holds of its folder, without a trip to the provider's
 * own client. Unavailable while the source holds nothing, which would be an
 * empty archive, and while a source's first import is still filling it,
 * which would be whatever part had arrived under a name that says "all" — the
 * storage panel holds its button back then too.
 */
const useDownloadCommand = ({
	connectionId,
	source,
	onProblem,
}: {
	connectionId: string | undefined;
	/** The source showing: `null` for the device's own, `undefined` until read. */
	source: SyncStateRecord | null | undefined;
	onProblem: (notice: Notice) => void;
}) => {
	const holds = useHoldsAnything(connectionId);
	useCommand({
		id: 'app.download',
		label: t('shell.commands.download'),
		group: t('shell.commands.group.app'),
		enabled: connectionId !== undefined && source?.importing === undefined && holds === true,
		run: () => {
			if (connectionId === undefined) return;
			void downloadSource(db, connectionId)
				.then((answer) => {
					const notice = downloadNotice(answer);
					if (notice !== null) onProblem({ message: notice, tone: 'warning' });
				})
				.catch((error: unknown) => {
					onProblem({ message: downloadProblem(error), tone: 'error' });
				});
		},
	});
};

/**
 * The shell's commands, registered in the order the palette has always had
 * them: the palette itself, a new note, search, download, undoing a delete,
 * and moving the open notebook or note.
 */
export const useShellCommands = ({
	setPaletteOpen,
	onCreateNote,
	scratchModal,
	setSearchOpen,
	searchField,
	connectionId,
	source,
	setProblem,
	deleted,
	undoDelete,
	folder,
	moving,
	pickUp,
	noteToMove,
	promote,
}: Readonly<{
	setPaletteOpen: (open: boolean) => void;
	onCreateNote: () => void;
	/** Whether a scratch card is open over the page (`useScratchpad`). */
	scratchModal: boolean;
	setSearchOpen: (open: boolean) => void;
	searchField: Readonly<RefObject<HTMLInputElement | null>>;
	connectionId: string | undefined;
	/** The source showing: `null` for the device's own, `undefined` until read. */
	source: SyncStateRecord | null | undefined;
	setProblem: (notice: Notice) => void;
	/** The note just deleted, for the notice's undo to take back (`useUndoDelete`). */
	deleted: NoteRecord | null;
	undoDelete: () => void;
	folder: string | undefined;
	moving: Moving | null;
	pickUp: (what: Moving) => void;
	/** The note the palette may pick up (`useNoteMove`). */
	noteToMove: NoteRecord | undefined;
	promote: ((note: NoteRecord) => void) | undefined;
}>) => {
	useCommand({
		id: 'app.palette',
		label: t('shell.commands.palette'),
		group: t('shell.commands.group.app'),
		chord: PALETTE,
		enabled: true,
		run: () => {
			setPaletteOpen(true);
		},
	});

	useCommand({
		id: 'note.new',
		label: t('shell.commands.newNote'),
		group: t('shell.commands.group.note'),
		chord: NEW_NOTE,
		enabled: canMakeNote(folder, scratchModal),
		run: onCreateNote,
	});

	useCommand({
		id: 'app.search',
		label: t('shell.commands.search'),
		group: t('shell.commands.group.app'),
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

	useDownloadCommand({ connectionId, source, onProblem: setProblem });

	useCommand({
		id: 'note.undoDelete',
		label: t('shell.commands.undoDelete'),
		group: t('shell.commands.group.note'),
		enabled: deleted !== null,
		run: undoDelete,
	});

	/**
	 * Picking up without a pointer. Dragging is a pointer gesture, and WCAG 2.2
	 * SC 2.5.7 asks that whatever it does be doable without one; this and
	 * `note.move` (`useNoteMove`, below) put the same thing in the air that
	 * `dragstart` does, and the destination rows in the sidebar are ordinary
	 * buttons, so a click or Enter on one puts it down. No chord: they are rare
	 * enough to be found in the palette, and every chord taken is one a note
	 * cannot use.
	 */
	useCommand({
		id: 'notebook.move',
		label: t('shell.commands.moveNotebook'),
		group: t('shell.commands.group.notebook'),
		// Nor can a second thing while one is already in the air.
		enabled: isNotebook(folder) && moving === null,
		run: () => {
			if (!isNotebook(folder)) return;
			pickUp({ kind: 'notebook', path: folder, name: basename(folder) });
		},
	});

	useNoteMove(noteToMove, moving, pickUp, promote);
};

/**
 * Installing the app is one of the things Chromium weighs when it decides
 * whether to keep a site's storage, so the question is put again then,
 * whatever it said before (`store/keeping.ts`). Silent there; the event is
 * Chromium's alone.
 */
export const useKeepOnInstall = () => {
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
