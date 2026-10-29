import type { Notice } from '../../components/notify.js';
import { showConnection } from '../../store/connection.js';
import { db, type NoteRecord } from '../../store/db.js';
import { noteIsUnder, rememberOpen } from '../../store/lastOpen.js';
import type { Pane } from '../panel.js';
import { type Place, placeFolder } from '../place.js';
import type { Select, useOpenPlace } from './useOpenPlace.js';

/**
 * The shell's ways of going somewhere: `select`, over the place open; a
 * notebook (`openFolder`); and a search result, in whichever source it is in
 * (`openResult`). Each answers the banner first, as anything else the user
 * does does. Made fresh at each render, over what is open then, as they were
 * in `Home`.
 */
export const useSelect = ({
	place,
	notes,
	activeConnection,
	setPanel,
	shutPanel,
	setSearchOpen,
	setProblem,
	dismissConnect,
}: Readonly<{
	place: Pick<
		ReturnType<typeof useOpenPlace>,
		'folder' | 'noteId' | 'openNote' | 'openedOver' | 'go'
	>;
	/** The notes listed, where the note gone to may be found by its id. */
	notes: readonly NoteRecord[] | undefined;
	activeConnection: string | undefined;
	setPanel: (panel: Pane | null) => void;
	/** Shut the dropdown, resolving once the history has it shut (`useCompactLayout`). */
	shutPanel: () => Promise<void>;
	setSearchOpen: (open: boolean) => void;
	setProblem: (notice: Notice | null) => void;
	dismissConnect: () => void;
}>) => {
	const { folder, noteId, openNote, openedOver, go } = place;

	/**
	 * Anything else the user does answers the banner: it is about the name they
	 * just tried, not about the app, and leaving it up means a message about a
	 * notebook they have since moved on from sits there for the session.
	 */
	const answerBanner = () => {
		setProblem(null);
		dismissConnect();
	};

	/**
	 * Go somewhere in the source showing: `next` over the notebook and note
	 * open. A step of the user's own is pushed, so Back undoes it; `replace`
	 * is for keeping the URL true to what has changed under it — a notebook
	 * renamed or moved, a delete, an undo. `note` is the note going to, where
	 * the caller has it, so the hash can name it at once.
	 */
	const select: Select = (next, { replace = false, note, panel } = {}) => {
		answerBanner();
		const to: Place = { folder, note: noteId, ...next };
		// Where the user is already, under a dropdown opened over it: the note
		// open, chosen again from its notes, shuts them, as Back would. Not
		// where the dropdown came with the place, as a notebook's notes come
		// with it: choosing from them is a step, for Back to come back to.
		if (!replace && openedOver(to)) {
			setPanel(panel ?? null);
			return;
		}
		const going =
			note ??
			[openNote, ...(notes ?? [])].find((each) => each !== undefined && each.id === to.note);
		go(to, { replace, notePath: going?.path, ...(panel === undefined ? {} : { panel }) });
	};

	/**
	 * Open a notebook. Only a note under the open notebook can be open, so the
	 * note showing stays only while it is under the one clicked — in it, or in
	 * a notebook inside it, at any depth (`noteIsUnder`). Clicking a parent of
	 * the note's own notebook used to clear it and leave an empty editor beside
	 * a list, which was the reported bug. Anywhere else the note is let go, and
	 * the notebook's own opens in its place (`useOpenPlace`): the one open last
	 * in it on this device, or its first. `panel` is what a compact window
	 * opens over it, in the same step (`afterFolder`).
	 */
	const openFolder = (path: string, panel: Pane | null = null) => {
		const keep = openNote !== undefined && noteIsUnder(openNote.path, path);
		select(keep ? { folder: path } : { folder: path, note: undefined }, { panel });
	};

	/**
	 * Open a search result. A result can be in any source and any notebook, and
	 * opening one has to take the user to all of it: the source first, since
	 * the notebook and the note named in the URL are read inside whichever
	 * source is showing, and then the notebook and the note together. Left in
	 * the source or the notebook they were in, the sidebar would highlight one
	 * place while the note beside it came from another, and clearing the search
	 * would leave the open note nowhere in the list.
	 */
	const openResult = (note: NoteRecord) => {
		// Done with: the field has emptied itself, and in a compact window the
		// bar goes back to its dropdowns rather than staying a search. A
		// dropdown open is shut by the step to the note, which has none.
		setSearchOpen(false);
		if (note.connectionId === activeConnection) {
			// A scratch note opens as its card, over the scratchpad.
			select({ folder: placeFolder(note.path), note: note.id }, { note });
			return;
		}
		// Another source: the entry in front is the old source's and is kept for
		// Back, and the new source's place goes after it (`useStanding`). That
		// place is the one remembered there, so the way to arrive somewhere in
		// it is to be remembered there first.
		answerBanner();
		// Shut first, as the new source's place is pushed with the dropdown the
		// entry before it had open (`useOpenPlace`).
		void shutPanel()
			.then(() => rememberOpen(db, note.connectionId, placeFolder(note.path), note.id))
			.then(() => showConnection(db, note.connectionId));
	};

	return { select, openFolder, openResult };
};
