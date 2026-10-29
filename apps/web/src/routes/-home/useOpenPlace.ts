import { cell, isVaultPath, parentPath, ROOT, SCRATCHPAD_FOLDER, VAULT_FOLDER } from '@skysa/core';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { type ConnectedSource, showConnection } from '../../store/connection.js';
import { db, type NoteRecord, type SyncStateRecord } from '../../store/db.js';
import {
	type NoteToOpen,
	useLastOpen,
	useNoteRead,
	useNoteToOpen,
	useSourceContents,
} from '../../store/hooks.js';
import { type LastOpen, noteIsUnder, pickNote, rememberOpen } from '../../store/lastOpen.js';
import { isUnnamed } from '../../store/notes.js';
import type { Pins } from '../../store/pins.js';
import { rememberRecent } from '../../store/recentNotes.js';
import { isLive } from '../../store/rowStates.js';
import { type FolderNode, selectedFolderPath } from '../../store/tree.js';
import { heldPanel, openedHere, type Pane, panelKept } from '../panel.js';
import {
	findNamedPlace,
	fragmentOf,
	heldPlace,
	isAppFolder,
	type NamedPlace,
	type Place,
	placeHash,
	placeState,
	placeTitle,
	readPlaceHash,
	samePlace,
} from '../place.js';
import { useDrafts } from './useDrafts.js';

/**
 * Matching the URL to the store: which notebook and note are open, as the
 * address and the history entry say (`routes/place.ts`) or as the device
 * remembers (`store/lastOpen.ts`); whether the source shown is still the one
 * they were for; and the page's title.
 */

/** The page's title with no note open: the brand's name (`brand.ts`). */
const APP_NAME = import.meta.env.VITE_APP_NAME ?? '';

/**
 * What the history entry in front says about where the user is (`place.ts`):
 * the place it holds, if it holds one, and its hash as written. `index` is the
 * entry's position in the tab's history, which a replace keeps and Back,
 * Forward and a push move.
 */
interface Entry {
	fragment: string;
	held: ReturnType<typeof heldPlace>;
	index: number;
}

const useEntry = (): Entry => {
	const href = useRouterState({ select: (state) => state.location.href });
	const state = useRouterState({ select: (state) => state.location.state });
	const held = useMemo(() => heldPlace(state), [state]);
	return { fragment: fragmentOf(href), held, index: state.__TSR_index };
};

/**
 * Whose place the entry in front is, beside the source showing. Each source is
 * its own notebooks and its own notes (§6), so a path or an id from one names
 * nothing in another, or worse, names something: a notebook called "Inbox" in
 * both would open the wrong one. How the entry came to be in front says what
 * to do with it:
 *
 * - `here`: the source showing's place, or no place at all — a link or an
 *   address typed, which is read in whichever source is showing.
 * - `left`: the source changed under it — a tab, a search answer in another
 *   source, a connect, or another window of the app showing another source.
 *   It is kept, for Back to come to, and the new source's place is pushed.
 * - `returning`: Back or Forward came to it. Its source is shown again, and
 *   the entry is where the user is in it.
 * - `stale`: in front as the app opened, from a source shown since in another
 *   window, or one Back came to that is no longer offered — let go of, or the
 *   device's own notes once they have all gone into the first source
 *   connected (`connectedSources`). Replaced.
 */
type Standing = 'here' | 'left' | 'returning' | 'stale';

const useStanding = (
	entry: Entry,
	activeConnection: string | undefined,
	sources: readonly ConnectedSource[] | undefined
): Standing => {
	const source = entry.held?.connectionId;
	const [seen, setSeen] = useState<{
		index: number;
		active: string | undefined;
		source: string | undefined;
		standing: Standing;
	}>();
	const changed =
		seen === undefined ||
		seen.index !== entry.index ||
		seen.active !== activeConnection ||
		seen.source !== source;
	const standing: Standing = !changed
		? seen.standing
		: source === undefined || activeConnection === undefined || source === activeConnection
			? 'here'
			: seen?.active === undefined
				? 'stale'
				: seen.index === entry.index
					? 'left'
					: 'returning';
	// In render rather than an effect (React's "adjusting state when a prop
	// changes"), so that no render reads another source's place as this one's.
	if (changed) setSeen({ index: entry.index, active: activeConnection, source, standing });
	// Known once the sources are: a source not among them is not one to show.
	const offered =
		sources === undefined ? undefined : sources.some((each) => each.connectionId === source);
	useEffect(() => {
		if (standing !== 'returning' || source === undefined || offered === undefined) {
			return undefined;
		}
		const asking = cell(true);
		const stale = () => {
			setSeen((now) => (now?.index === entry.index ? { ...now, standing: 'stale' } : now));
		};
		if (!offered) {
			stale();
			return undefined;
		}
		void showConnection(db, source).then((shown) => {
			if (!shown && asking.current) stale();
		});
		return () => {
			asking.current = false;
		};
	}, [standing, source, offered, entry.index]);
	return standing;
};

/**
 * Go somewhere: a step of the user's own, pushed, or put in place of the
 * entry. `panel` is the dropdown open over it in a compact window
 * (`usePanel`): a step pushed has none unless it says, and one put in place
 * keeps the entry's unless it says.
 */
type Go = (
	place: Place,
	how: { replace: boolean; notePath?: string | undefined; panel?: Pane | null }
) => void;

/**
 * Going somewhere in the source showing, as the shell does over `Go`
 * (`select` in `routes/-home/useSelect.ts`): `next` over the notebook and note open,
 * pushed as a step of the user's own unless `replace` keeps the URL true to
 * what has changed under it.
 */
export type Select = (
	next: Place,
	options?: { replace?: boolean; note?: NoteRecord; panel?: Pane | null }
) => void;

/**
 * An entry with no place of its own — a link, or an address typed — is read by
 * name, once (`findNamedPlace`). What it names is written into the entry by id
 * (`place.ts`), and the entry goes by that from then on. Until then
 * `resolving` holds off showing a notebook, or choosing a note in one: the
 * slugs say which only once the source's names have been read.
 */
const useNamedPlace = (
	entry: Entry,
	activeConnection: string | undefined,
	go: Go
): { resolving: boolean } => {
	const { held, fragment } = entry;
	const named = useMemo(
		(): NamedPlace => (held === undefined ? readPlaceHash(fragment) : {}),
		[held, fragment]
	);
	const asking = named.folder === undefined ? undefined : fragment;
	const contents = useSourceContents(activeConnection, asking);
	useEffect(() => {
		if (contents === undefined) return;
		const { folder, note } = findNamedPlace(named, contents.folders, contents.notes);
		go({ folder, note: note?.id }, { replace: true, notePath: note?.path });
	}, [named, contents, go]);
	return { resolving: asking !== undefined };
};

/** The remembered notebook as `selectedFolderPath` takes it: `null` for none. */
const rememberedFolder = (lastOpen: LastOpen | undefined): string | null | undefined =>
	lastOpen === undefined ? undefined : (lastOpen.folder ?? null);

/**
 * Keep the device's memory of where the user is (`store/lastOpen.ts`) in step
 * with what is open: the notebook, and the note while it is one of that
 * notebook's. Written only once the memory has been read, so a place is never
 * remembered over one that was about to be restored.
 *
 * And when this tab's place moves, not because the memory says something
 * else. The memory is the device's, and another tab showing another notebook
 * writes its own place into it: told "not here" by the memory, two tabs wrote
 * theirs back over each other for as long as both were open (#305). Whether
 * the memory says so already is the write's to ask (`rememberOpen`), of what
 * is stored.
 *
 * The note is put at the head of the notes opened lately as well, for the
 * search field to offer (`store/recentNotes.ts`): at once, since that list is
 * no place to be restored, and the memory of the place has nothing to do
 * with it.
 */
const useRememberOpen = ({
	connectionId,
	folder,
	noteId,
	openNote,
	lastOpen,
}: {
	connectionId: string | undefined;
	folder: string | undefined;
	noteId: string | undefined;
	openNote: NoteRecord | undefined;
	lastOpen: LastOpen | undefined;
}) => {
	// The note in the URL, by id, and only once it is the one open: a note
	// begun, or one a render behind the URL, is not.
	const note =
		openNote !== undefined &&
		openNote.id === noteId &&
		folder !== undefined &&
		noteIsUnder(openNote.path, folder)
			? openNote.id
			: undefined;
	const read = lastOpen !== undefined;
	useEffect(() => {
		if (connectionId === undefined || folder === undefined || !read) return;
		void rememberOpen(db, connectionId, folder, note);
	}, [connectionId, folder, note, read]);
	useEffect(() => {
		if (connectionId === undefined || note === undefined) return;
		void rememberRecent(db, connectionId, note);
	}, [connectionId, note]);
};

/**
 * Which notebook and note are open.
 *
 * The notebook is the URL's, else the one open last on this device, else the
 * first (`selectedFolderPath`). The note is the URL's while it is there to
 * show, else the one open last in that notebook, else the notebook's first
 * (`pickNote`) — and that answer is written to the URL, in place of the entry
 * it was worked out on, so the note list, the editor, a reload and Back all
 * agree on it. A notebook with no notes in it starts one (`useDrafts`), unless
 * it is the loose notes, where the app makes none (§12.6), or `startable` says
 * notes are still arriving.
 *
 * One path for every way a notebook comes to be showing: clicked, restored at
 * start, fallen back to after a delete, or a source's first notebook as a
 * first import fills it. Opening a note used to follow a click on a notebook
 * and nothing else, so a notebook the app opened by itself showed a list
 * beside an empty pane.
 */
export const useOpenPlace = ({
	activeConnection,
	sources,
	tree,
	looseNoteCount,
	pins,
	startable,
	scratchpad,
	passwords,
	onStoreFailed,
}: {
	activeConnection: string | undefined;
	/** The sources offered, which Back may show again. */
	sources: readonly ConnectedSource[] | undefined;
	tree: FolderNode[] | undefined;
	looseNoteCount: number | undefined;
	/** What the source has pinned: a notebook opens on a pinned note first. */
	pins: Pins | undefined;
	/**
	 * Whether an empty notebook may start a note. Not while a source's first
	 * import is filling it: the notebook is empty only because its notes have
	 * not arrived yet.
	 */
	startable: boolean;
	/**
	 * Whether the source shows its scratchpad on this device, which is when
	 * the scratchpad can be open; `undefined` until read.
	 */
	scratchpad: boolean | undefined;
	/** The same for its passwords (docs/ARCHITECTURE.md §7, "Passwords in the vault"). */
	passwords: boolean | undefined;
	onStoreFailed: () => void;
}) => {
	const router = useRouter();
	const navigate = useNavigate({ from: '/' });
	const entry = useEntry();
	const standing = useStanding(entry, activeConnection, sources);

	const go = useCallback<Go>(
		(place, { replace, notePath, panel }) => {
			if (activeConnection === undefined) return;
			const now = router.history.location.state;
			const held = heldPlace(now);
			const kept = replace
				? panelKept(now, held?.connectionId === activeConnection && samePlace(held, place))
				: {};
			void navigate({
				// Whatever the query holds is another page's message, read and
				// taken out on its own.
				search: true,
				hash: placeHash(place.folder, notePath),
				state: {
					...placeState(activeConnection, place),
					...(panel === undefined ? kept : panel === null ? {} : { panel }),
				},
				replace,
			});
		},
		[activeConnection, navigate, router]
	);

	/**
	 * Whether the entry in front is a dropdown opened over `place`, in the
	 * source showing: the step Back from it takes is to `place` itself.
	 */
	const openedOver = useCallback(
		(place: Place): boolean => {
			const now = router.history.location.state;
			const held = heldPlace(now);
			return (
				openedHere(now) && held?.connectionId === activeConnection && samePlace(held, place)
			);
		},
		[activeConnection, router]
	);

	const { resolving } = useNamedPlace(entry, activeConnection, go);
	// The entry's place in the source showing; nothing, while it is another's.
	const here: Place = standing !== 'here' ? {} : (entry.held ?? {});
	const requestedFolder = here.folder;
	const noteId = here.note;
	/** Whether the entry says where the user is, or is about to. */
	const settled = standing !== 'returning' && !resolving;

	const lastOpen = useLastOpen(activeConnection);
	// None while a link is read, rather than the one remembered a moment
	// before the one it names.
	const folder = resolving
		? undefined
		: openFolderPath(tree, requestedFolder, looseNoteCount, rememberedFolder(lastOpen), {
				[SCRATCHPAD_FOLDER]: scratchpad,
				[VAULT_FOLDER]: passwords,
			});
	/** The scratchpad or the passwords: a place that is no notebook. */
	const inAppPlace = isAppFolder(folder);
	const remembered = folder === undefined ? undefined : lastOpen?.notes[folder];
	const pinnedNotes = pins?.notes;
	const toOpen = useNoteToOpen({
		connectionId: activeConnection,
		// The scratchpad opens on its cards, never on a note, and the passwords
		// on their list: nothing to pick.
		folder: inAppPlace ? undefined : folder,
		open: noteId,
		remembered,
		pinned: pinnedNotes,
		tree,
		ready: lastOpen !== undefined && settled,
	});

	const found = useNoteRead(noteId);
	// A password is open only in the passwords: named anywhere else — by an
	// address kept from while they were shown — it is no note to show there,
	// and the place picks one of its own (`pickNote`).
	const storedNote =
		found === null ||
		found === undefined ||
		(isVaultPath(found.path) && folder !== VAULT_FOLDER)
			? undefined
			: found;
	// A note asked for and not read yet: the pane says it is opening rather
	// than that nothing is open, which is what it said while the read was held
	// up behind another tab's write (2026-10-10).
	const opening = noteId !== undefined && found === undefined;
	const drafts = useDrafts({
		connectionId: activeConnection,
		noteId,
		storedNote,
		onStoreFailed,
	});
	const { draft, begin } = drafts;
	const begun = drafts.open;
	const openNote = storedNote ?? begun;

	useEffect(() => {
		// A note begun is open, though it is not in the store to be found.
		if (begun !== undefined || activeConnection === undefined) return undefined;
		// Not while the entry is about to say: a live query keeps its last
		// answer until the next, and an answer from before Back came to another
		// source's entry would be written over it.
		if (!settled) return undefined;
		// The note the URL names is there to show, so there is nothing to choose
		// (`pickNote` answers the same). Asked here, not left to that answer: it
		// can be one worked out while the note was still begun and not stored —
		// when the notebook's remembered note was the answer — and arrive after
		// the note it was about has been stored.
		if (isLive(storedNote)) return undefined;
		// An answer to the question as it stands, not to one asked a click ago.
		if (toOpen === undefined || toOpen.folder !== folder || toOpen.open !== noteId) {
			return undefined;
		}
		const workedOutOn = entry.index;
		const show = (pick: NoteRecord | string | undefined) => {
			const id = typeof pick === 'object' ? pick.id : pick;
			// Where the source changed under the entry, the source's place is a
			// step of its own even when it names no note.
			if (id === noteId && standing !== 'left') return;
			// And only onto the entry it was worked out from, as it was then: the
			// user may have clicked somewhere else while the store was answering.
			// The history's own, which a navigation moves at once, where the
			// router's follows a moment later.
			const now = router.history.location.state;
			const held = heldPlace(now);
			const stillHere = held?.connectionId === activeConnection ? held : {};
			if (
				now.__TSR_index !== workedOutOn ||
				!samePlace(stillHere, { folder: requestedFolder, note: noteId })
			) {
				return;
			}
			go(
				{ folder: toOpen.folder, note: id },
				{
					replace: standing !== 'left',
					notePath: typeof pick === 'object' ? pick.path : undefined,
					// A source chosen from its dropdown goes on to its notebooks.
					...(standing === 'left' ? { panel: heldPanel(now) } : {}),
				}
			);
		};
		if (!beginsHere(toOpen, startable)) {
			show(toOpen.pick ?? undefined);
			return undefined;
		}
		// One already begun here and left is the same blank page, so it is
		// opened again rather than another made beside it.
		const blank = () =>
			draft !== null &&
			draft.connectionId === activeConnection &&
			parentPath(draft.path) === toOpen.folder
				? draft
				: begin(toOpen.folder, []);
		// Empty by a read that may already be behind: an undo or a pull can put
		// a note in the notebook between that read and this, and a note opened
		// over it would hide the one that arrived. So the store is asked again,
		// now, and nothing is opened for a question that has moved on meanwhile.
		const asking = cell(true);
		void pickNote(db, {
			connectionId: activeConnection,
			folderPath: toOpen.folder,
			open: noteId,
			remembered,
			pinned: pinnedNotes,
			tree,
		}).then((again) => {
			if (asking.current) show(again ?? blank());
		});
		return () => {
			asking.current = false;
		};
	}, [
		toOpen,
		folder,
		noteId,
		requestedFolder,
		remembered,
		pinnedNotes,
		tree,
		router,
		go,
		standing,
		settled,
		entry.index,
		begun,
		storedNote,
		startable,
		draft,
		activeConnection,
		begin,
	]);

	// The scratchpad, or the passwords, open as the place remembered or fallen
	// back to, is put in the entry as a notebook the app opens by itself is
	// (`show` above).
	useEffect(() => {
		if (!isAppFolder(folder) || !settled || requestedFolder === folder) return;
		go(
			{ folder },
			standing === 'left'
				? { replace: false, panel: heldPanel(router.history.location.state) }
				: { replace: true }
		);
	}, [folder, settled, requestedFolder, standing, go, router]);

	// The hash says by path what the entry holds by id, and follows the note
	// when it is renamed or moved, here or on another device.
	const { held, fragment } = entry;
	useEffect(() => {
		if (standing !== 'here' || held === undefined) return;
		// Not read yet, or gone: the note chosen in its place says the rest.
		if (held.note !== undefined && openNote?.id !== held.note) return;
		const hash = placeHash(held.folder, openNote?.path);
		if (hash !== fragment) {
			void navigate({ search: true, hash, state: true, replace: true });
		}
	}, [standing, held, fragment, openNote, navigate]);

	const title = placeTitle(
		openNote === undefined ? undefined : { ...openNote, named: !isUnnamed(openNote) },
		APP_NAME,
		folder
	);
	useEffect(() => {
		// eslint-disable-next-line functional/immutable-data -- the page's title is set by assigning to it
		document.title = title;
	}, [title]);

	useRememberOpen({
		connectionId: settled ? activeConnection : undefined,
		folder,
		noteId,
		// The scratchpad is remembered, and not the card open in it: the app
		// opens on the cards, not on one of them over the rest. Nor the password
		// open: the app opens on the list, not on an item, locked or asking.
		// Nor is either among the notes opened lately, which are notes only
		// (the owner's choice, 2026-10-15).
		openNote: inAppPlace ? undefined : storedNote,
		lastOpen,
	});

	return {
		folder,
		noteId,
		/** The note open: stored, or begun and not yet. */
		openNote,
		storedNote,
		opening,
		begun,
		begin,
		noteDraft: drafts.noteDraft,
		go,
		openedOver,
	};
};

/**
 * Which notebook to open, as `selectedFolderPath` has it, or the scratchpad
 * (docs/ARCHITECTURE.md §7, "The scratchpad") or the passwords ("Passwords in
 * the vault"): asked for, or remembered with nothing asked for, while the
 * source shows it, as `shown` says by folder. Not yet known while whether it
 * does is still being read. One hidden is a notebook deleted: the place falls
 * back as from one.
 */
const openFolderPath = (
	tree: FolderNode[] | undefined,
	requested: string | undefined,
	looseNoteCount: number | undefined,
	remembered: string | null | undefined,
	shown: Readonly<Record<string, boolean | undefined>>
): string | undefined => {
	const asked = requested ?? remembered;
	if (isAppFolder(asked) && shown[asked] === true) return asked;
	if (isAppFolder(asked) && shown[asked] === undefined) return undefined;
	return selectedFolderPath(
		tree,
		isAppFolder(requested) ? undefined : requested,
		looseNoteCount,
		isAppFolder(remembered) ? null : remembered
	);
};

/**
 * Whether the store's answer is a notebook with nothing in it, where
 * `useOpenPlace` begins a note: not the loose notes, which the app never adds
 * to, and not while `startable` says notes are still arriving.
 */
const beginsHere = ({ folder, pick }: NoteToOpen, startable: boolean): boolean =>
	pick === null && startable && folder !== ROOT;

/**
 * Whether an empty notebook may begin a note (`useOpenPlace`): once the source
 * is known, and not while its first import is still bringing its notes in.
 */
export const canBegin = (
	source: SyncStateRecord | null | undefined,
	held: SyncStateRecord | undefined
): boolean => source !== undefined && source?.importing === undefined && held === undefined;
