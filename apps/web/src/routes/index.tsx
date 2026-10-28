import {
	basename,
	isVaultPath,
	parentPath,
	ROOT,
	SCRATCHPAD_FOLDER,
	VAULT_FOLDER,
} from '@skysa/core';
import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';

import { CommandsProvider, useShortcuts } from '../commands/context.js';
import { AccountPanel, returnPath } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { CompactBar } from '../components/CompactBar.js';
import { DeletedNotice } from '../components/DeletedNotice.js';
import { ErrorScreen } from '../components/ErrorScreen.js';
import { HeldImport } from '../components/ImportProgress.js';
import { NameDialog } from '../components/NameDialog.js';
import { NoteList } from '../components/NoteList.js';
import { noteMenuItems } from '../components/noteMenu.js';
import { NoteView, type NoteViewHandle, type ScratchEditing } from '../components/NoteView.js';
import { type Notice, NotifyContext } from '../components/notify.js';
import { PasswordItem } from '../components/PasswordItem.js';
import { Passwords } from '../components/Passwords.js';
import { CardSheet, ScratchModal, Scratchpad } from '../components/Scratchpad.js';
import { NoteSearchField, SearchQuery } from '../components/SearchField.js';
import { Sidebar } from '../components/Sidebar.js';
import { SourceTabs } from '../components/SourceTabs.js';
import { Toast } from '../components/Toast.js';
import { usePasswords } from '../components/usePasswords.js';
import { useOpenWhenShown, useScratchpad } from '../components/useScratchpad.js';
import { useLatest } from '../hooks/useLatest.js';
import { t } from '../i18n/t.js';
import { InstallBanner } from '../install/InstallBanner.js';
import { TakeShare } from '../share/TakeShare.js';
import { showConnection } from '../store/connection.js';
import { db, type NoteRecord, noteRef, type SyncStateRecord } from '../store/db.js';
import {
	useActiveConnectionId,
	useActiveSource,
	useHeldImport,
	useLooseNoteCount,
	useOpenNotebooks,
	usePasswordsShown,
	usePinnedTree,
	useScratchpadShown,
	useSources,
} from '../store/hooks.js';
import { noteIsUnder, rememberOpen } from '../store/lastOpen.js';
import { createLiveEdits } from '../store/liveEdits.js';
import { deleteNote, getNote } from '../store/notes.js';
import { setNotebooksOpen } from '../store/openNotebooks.js';
import { setNotebookPin, setNotePinned } from '../store/pins.js';
import { createRenamings } from '../store/renaming.js';
import { isLive } from '../store/rowStates.js';
import { scratchMarks } from '../store/scratchpad.js';
import { nameShown, titleShown } from '../store/titles.js';
import { findFolder, notesUnder } from '../store/tree.js';
import { PROVIDER_LABELS, sourceName, tabName } from '../sync/account.js';
import { useEnterCode, useKeepOnInstall, useShellCommands } from './-home/commands.js';
import { useCodeAskedAgain, useConnectNotice } from './-home/connectNotice.js';
import { canMakeNote, covered, emptyPaneOffers, placeRow } from './-home/rules.js';
import { SourceDropdown } from './-home/SourceDropdown.js';
import { useBegunInView, useListedNotes } from './-home/useListedNotes.js';
import { useEscapePutsDown, useMoving } from './-home/useMoving.js';
import { useNotebookActions } from './-home/useNotebookActions.js';
import { canBegin, type Select, useOpenPlace } from './-home/useOpenPlace.js';
import { useUndoDelete } from './-home/useUndoDelete.js';
import { type Pane, useCompactLayout } from './panel.js';
import { type Place, placeFolder } from './place.js';
import { parseSearch } from './search.js';

/**
 * The app. Which folder and note are open lives in the URL rather than in
 * component state — by path in the hash, by id in the history entry
 * (`place.ts`) — so reloading, following a link, or going Back or Forward
 * lands the user where it says; and on the device (`store/lastOpen.ts`), so
 * reopening the PWA at its start URL, or showing a source again, lands them
 * where they were. The matching is `-home/useOpenPlace.ts`.
 */

/**
 * What the banner across the top says while a disconnected source is showing:
 * by its name and its storage's, where it has them (`sourceName`, which has a
 * name for every source with a provider).
 */
const detachedText = (source: SyncStateRecord): string => {
	const name = sourceName(source);
	return source.provider === undefined || name === undefined
		? t('shell.detached.unnamed')
		: t('shell.detached.named', { source: name, provider: PROVIDER_LABELS[source.provider] });
};

const Home = () => {
	const { connect, code, enter, share } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	// Where a connect started from the tab bar should come back to.
	const href = useRouterState({ select: (state) => state.location.href });

	const source = useActiveSource();
	// A new source's import holds the app, the first's and every one after:
	// nothing may be done in it, or to the notes being moved into it, until
	// it is through.
	const held = useHeldImport();
	const { connectNotice, dismissConnect } = useConnectNotice(connect, code, held);
	useCodeAskedAgain(connect);
	const activeConnection = useActiveConnectionId();
	const openNotebooks = useOpenNotebooks(activeConnection);
	const onOpenNotebooks = useCallback(
		(paths: string[], open: boolean) => {
			if (activeConnection !== undefined)
				void setNotebooksOpen(db, activeConnection, paths, open);
		},
		[activeConnection]
	);
	const sources = useSources();
	const { tree, pins } = usePinnedTree(activeConnection);
	const looseNoteCount = useLooseNoteCount(activeConnection);

	/**
	 * Why the last thing the user asked for did not happen. Creating a notebook
	 * or a note can reject — a duplicate name is the everyday case — and by then
	 * the name field has closed and the click is over, so without somewhere to
	 * put this the user acts and the app shows nothing at all.
	 */
	const [problem, setProblem] = useState<Notice | null>(null);
	/**
	 * What a component inside the shell had to say (`useNotify`): how an import
	 * went, said over the page rather than in the panel it was started from.
	 */
	const [told, setTold] = useState<Notice | null>(null);
	const dismissTold = useCallback(() => {
		setTold(null);
	}, []);
	/** What is typed into the open note before it is saved, for the list to show. */
	const [liveEdits] = useState(createLiveEdits);
	/** A notebook or source being renamed, for everything else that names it. */
	const [renamings] = useState(createRenamings);
	// Rarer than a duplicate notebook name — this one needs the store itself to
	// refuse — but the same silence if it happens: the user types into a note
	// that is nowhere, and the failure goes to the console.
	const noteNotMade = useCallback(() => {
		setProblem({ message: t('shell.note.notMade'), tone: 'error' });
	}, []);

	const scratchpadShown = useScratchpadShown(activeConnection);
	const passwordsShown = usePasswordsShown(activeConnection);
	const place = useOpenPlace({
		activeConnection,
		sources,
		tree,
		looseNoteCount,
		pins,
		startable: canBegin(source, held),
		scratchpad: scratchpadShown,
		passwords: passwordsShown,
		onStoreFailed: noteNotMade,
	});
	const { folder, noteId, openNote, storedNote, opening, go, openedOver } = place;
	/** The scratchpad is open, in the notes' place (docs/ARCHITECTURE.md §7). */
	const inScratchpad = folder === SCRATCHPAD_FOLDER;
	/** The passwords are open, in the notes' place ("Passwords in the vault"). */
	const inPasswords = folder === VAULT_FOLDER;
	const { own, notes, unsavedNoteId } = useListedNotes(
		activeConnection,
		folder,
		place.begun,
		pins,
		tree
	);
	// Read by a continuation that finishes after the user may have moved on.
	/** The note pane, which deletes a note from the list's menu as from its own. */
	const noteView = useRef<NoteViewHandle>(null);
	const noteIdRef = useLatest(noteId);

	/**
	 * What a search result calls the source it is in. Said only when there is
	 * more than one: with a single source every row would say the same thing.
	 */
	const resultSourceName = (connectionId: string): string | undefined => {
		if (sources === undefined || sources.length < 2) return undefined;
		const found = sources.find((each) => each.connectionId === connectionId);
		return found === undefined ? undefined : tabName(found, sources);
	};
	/** The note on screen, which the notes opened lately leave out. */
	const showing = storedNote === undefined ? undefined : noteRef(storedNote);

	/**
	 * A window too narrow for three panes. The notebooks and the notes become
	 * dropdowns in the bar and the note takes the rest (`CompactBar`); `panel`
	 * is which of them is open, and `searchOpen` whether the search has the bar.
	 */
	const {
		compact,
		panel,
		setPanel,
		shutPanel,
		setRest,
		searchOpen,
		setSearchOpen,
		setOrigins,
		frameClassName,
		shellProps,
	} = useCompactLayout();
	useBegunInView(place.begun, setPanel);
	const enterCode = useEnterCode(enter, compact);
	// Something shared to the app (`share/TakeShare.tsx`): out of the URL once
	// read, so a reload does not ask again, and the clipboard brought into
	// view once it has it, which in a compact window is in the sources
	// dropdown.
	const shareRead = useCallback(() => {
		void navigate({
			search: ({ share: _share, ...rest }) => rest,
			hash: true,
			state: true,
			replace: true,
		});
	}, [navigate]);
	const shareAdded = useCallback(() => {
		if (compact) setPanel('sources');
	}, [compact, setPanel]);
	const [paletteOpen, setPaletteOpen] = useState(false);
	/**
	 * The search field, so a command can put the cursor in it. A command that
	 * only *said* "search" and left the user to find the box would be a slower
	 * way of doing nothing.
	 */
	const searchField = useRef<HTMLInputElement>(null);

	/**
	 * Go somewhere in the source showing: `next` over the notebook and note
	 * open. A step of the user's own is pushed, so Back undoes it; `replace`
	 * is for keeping the URL true to what has changed under it — a notebook
	 * renamed or moved, a delete, an undo. `note` is the note going to, where
	 * the caller has it, so the hash can name it at once.
	 */
	const select: Select = (next, { replace = false, note, panel } = {}) => {
		// Anything else the user does answers the banner: it is about the name they
		// just tried, not about the app, and leaving it up means a message about a
		// notebook they have since moved on from sits there for the session.
		setProblem(null);
		dismissConnect();
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
		setProblem(null);
		dismissConnect();
		// Shut first, as the new source's place is pushed with the dropdown the
		// entry before it had open (`useOpenPlace`).
		void shutPanel()
			.then(() => rememberOpen(db, note.connectionId, placeFolder(note.path), note.id))
			.then(() => showConnection(db, note.connectionId));
	};

	const { deleted, setDeleted, undoFailed, setBeside, dismissDeleted, undoDelete } =
		useUndoDelete({ select, setProblem });
	const dismissProblem = useCallback(() => {
		setProblem(null);
	}, []);

	/**
	 * Begin a note in the open notebook: on screen, named "Untitled" with the
	 * name selected, and stored only once the user writes in it (`useDrafts`).
	 */
	const onCreateNote = () => {
		// The scratchpad's new note is its box's.
		if (inScratchpad) {
			scratch.take();
			return;
		}
		if (inPasswords) {
			passwords.add();
			return;
		}
		// The root holds loose notes that arrived from the remote folder; the app
		// does not add to them (docs/ARCHITECTURE.md §12.6).
		if (folder === undefined || folder === ROOT) return;
		const made = place.begin(
			folder,
			(own ?? []).map((note) => basename(note.path))
		);
		if (made !== undefined) select({ folder, note: made.id }, { note: made });
	};

	const { onCreateFolder, onRenameFolder, onDeleteFolder } = useNotebookActions({
		folder,
		openNote,
		select,
		openFolder,
		setProblem,
		renamings,
	});

	const { moving, setMoving, cancelMove, pickUp, onDropInto } = useMoving({
		compact,
		setPanel,
		shutPanel,
		select,
		setProblem,
		folder,
		noteIdRef,
	});

	/**
	 * What a compact window shows once a notebook is chosen: its notes, to
	 * choose one from next, as a source chosen goes on to its notebooks. So
	 * does a notebook whose notes are all in notebooks inside it: they are its
	 * list, and the note it opens on waits behind them (`pickNote`) rather than
	 * showing in their place. Not for a notebook with no notes in it at any
	 * depth, where a note begins and is what shows (`useBegunInView`) — the
	 * notes would be opened only to be shut on it.
	 */
	const afterFolder = (path: string): Pane | null => {
		if (!compact) return null;
		const node = path === ROOT || tree === undefined ? undefined : findFolder(tree, path);
		const empty = node !== undefined && notesUnder(node) === 0;
		return empty && canBegin(source, held) ? null : 'notes';
	};

	/**
	 * How many times an empty state has asked for a new notebook. The field is
	 * the sidebar's, so this is a request it answers rather than state it
	 * shares — and the sidebar is opened for it in a compact window, where it
	 * is a dropdown the field would otherwise be hidden in.
	 */
	const [newNotebookAsked, setNewNotebookAsked] = useState(0);
	const askNewNotebook = () => {
		setNewNotebookAsked((times) => times + 1);
		if (compact) setPanel('notebooks');
	};

	const scratch = useScratchpad({
		active: inScratchpad,
		connectionId: activeConnection,
		noteId,
		openNote,
		opening,
		begin: place.begin,
		select,
		compact,
		setPanel,
		setRest,
		noteView,
		onDeleted: (note) => {
			setDeleted(note);
			setBeside(null);
		},
		pickUp,
		moving,
		onProblem: (message) => {
			setProblem({ message, tone: 'error' });
		},
	});
	useOpenWhenShown(activeConnection, scratchpadShown, scratch.show);

	const passwords = usePasswords({
		active: inPasswords,
		connectionId: activeConnection,
		noteId,
		begin: place.begin,
		select,
		compact,
		setPanel,
		setRest,
	});

	/**
	 * Delete a password, taken away at once with the notice's undo, as a note
	 * is; the list is what shows in its place.
	 */
	const deletePassword = (note: NoteRecord) => {
		const home = { connectionId: note.connectionId };
		void deleteNote(db, note.id, home)
			.then(() => getNote(db, note.id, home).catch(() => undefined))
			.then((row) => {
				setDeleted(row ?? note);
				setBeside(null);
				if (noteIdRef.current === note.id) {
					select({ folder: VAULT_FOLDER, note: undefined }, { replace: true });
				}
			})
			.catch(() => {
				setProblem({ message: t('passwords.item.notDeleted'), tone: 'error' });
			});
	};

	useEscapePutsDown(moving, setMoving);

	useShellCommands({
		setPaletteOpen,
		onCreateNote,
		canNew: canMakeNote(folder, scratch.modal),
		setSearchOpen,
		searchField,
		connectionId: activeConnection,
		source,
		setProblem,
		canUndo: deleted !== null,
		undoDelete,
		folder,
		moving,
		pickUp,
		// A note begun and not stored has nowhere to move from yet.
		// Nor a password, which is no note to put in a notebook.
		noteToMove: inPasswords ? undefined : storedNote,
		promote: scratch.moveOpen,
	});
	useKeepOnInstall();

	useShortcuts();

	/**
	 * The note pane. One is ever mounted, wherever the note open is shown — the
	 * third column, the scratchpad's box, a card's dialog — since the commands
	 * it registers and the edits it holds are the open note's alone.
	 */
	const noteEditor = (scratchNote?: ScratchEditing) => (
		<NoteView
			ref={noteView}
			note={openNote}
			opening={opening}
			draft={place.noteDraft}
			liveEdits={liveEdits}
			renamings={renamings}
			onProblem={setProblem}
			scratch={scratchNote}
			{...emptyPaneOffers({
				folder,
				nothingYet: tree?.length === 0 && looseNoteCount === 0,
				onCreateNote,
				onCreateNotebook: askNewNotebook,
			})}
			// The next note along follows by itself: a tombstone is not a note
			// to show, so the one open last in the notebook, or its first,
			// takes its place (`useOpenPlace`). Not in the scratchpad, whose
			// card or box closes instead.
			onDeleted={(note, displaced) => {
				setDeleted(note);
				setBeside(displaced ?? null);
				scratch.deleted(note);
			}}
		/>
	);

	/**
	 * What is in the note's column in the scratchpad: in a compact window, the
	 * card open, full screen; nothing open, an empty pane behind the
	 * scratchpad's. In a wide one the scratchpad has the column too.
	 */
	const noteColumn = () => {
		if (inPasswords) return passwordColumn();
		if (!inScratchpad) return noteEditor();
		if (!compact) return null;
		if (scratch.card !== undefined) {
			// A pane open with a card open is a dropdown over it: nothing rests
			// under a card (`useScratchpad`).
			return (
				<CardSheet id={scratch.card.id} unseen={panel !== null}>
					{noteEditor(scratch.editing)}
				</CardSheet>
			);
		}
		return <section className="note-view empty" aria-label={t('shell.notePane')} />;
	};

	/**
	 * What is in the note's column in the passwords: the item open, or, with
	 * none, what to do, or in a compact window an empty pane behind the list.
	 * Keyed by the item, so nothing one showed is there as another opens.
	 */
	const passwordColumn = () => {
		if (openNote !== undefined && isLive(openNote) && isVaultPath(openNote.path)) {
			return (
				<PasswordItem
					key={openNote.id}
					note={openNote}
					draft={place.noteDraft}
					onProblem={setProblem}
					onDelete={deletePassword}
					// Not `select`, which would take down what the item had to
					// say: why a new one could not be begun.
					onClose={() => {
						go({ folder: VAULT_FOLDER }, { replace: true, notePath: undefined });
					}}
					onOpen={(note) => {
						select({ folder: VAULT_FOLDER, note: note.id }, { replace: true, note });
					}}
				/>
			);
		}
		if (compact)
			return <section className="note-view empty" aria-label={t('shell.notePane')} />;
		return (
			<section className="note-view empty" aria-label={t('shell.notePane')}>
				<p className="muted placeholder">
					{opening ? t('passwords.item.opening') : t('passwords.none')}
				</p>
			</section>
		);
	};

	/** The scratchpad, in the notes' place. */
	const scratchPane = () => (
		<Scratchpad
			notes={scratch.notes}
			takingId={scratch.takingId}
			editor={scratch.taking ? noteEditor(scratch.editing) : undefined}
			onTake={scratch.take}
			onCloseTake={scratch.closeTake}
			openId={scratch.card?.id}
			openingId={scratch.openingId}
			onOpen={scratch.open}
			onMark={scratch.mark}
			onMove={scratch.offered}
			onDelete={scratch.remove}
			liveEdits={liveEdits}
		/>
	);

	/** What the scratchpad puts over the page: a card's dialog, and the name it asks for. */
	const scratchOverlays = () => (
		<>
			{scratch.modal && scratch.card !== undefined && (
				<ScratchModal
					id={scratch.card.id}
					color={scratchMarks(scratch.card).color}
					onClose={scratch.close}
				>
					{noteEditor(scratch.editing)}
				</ScratchModal>
			)}
			{scratch.naming !== undefined && (
				<NameDialog
					title={t('shell.nameNote.title')}
					text={t('shell.nameNote.text')}
					label={t('shell.nameNote.label')}
					confirmLabel={t('shell.nameNote.confirm')}
					onConfirm={scratch.named}
					onCancel={scratch.cancelNaming}
				/>
			)}
		</>
	);

	return (
		// `app-shell` is a three-column grid with exactly three children. A banner
		// put inside it becomes a fourth grid item, takes the sidebar's column and
		// pushes the note view into a clipped second row, so anything that sits
		// above the panes goes in the frame around them instead. The toasts are
		// not laid out at all — they are fixed to the viewport — but they are
		// here for the same reason: a stack in the grid would take a column.
		<NotifyContext.Provider value={setTold}>
			<div className={frameClassName} inert={covered(held, scratch.modal)}>
				{/*
				 * Above everything, because it says which app this is: each source
				 * is its own notes, its own notebooks and its own sync (§6), so the
				 * panes below all mean something different depending on which of
				 * these is lit.
				 */}
				<SearchQuery>
					{(query, setQuery) =>
						compact ? (
							<CompactBar
								folder={folder}
								// In the scratchpad, the card open, named after
								// "Scratchpad" if it has a name or words to go by.
								note={scratch.barNote(openNote)}
								scratchpad={inScratchpad}
								passwords={inPasswords}
								liveEdits={liveEdits}
								renamings={renamings}
								panel={panel}
								onPanel={setPanel}
								query={query}
								onQuery={(next) => {
									setQuery(next);
									// The answers hang from the field, over whatever
									// else is open; a dropdown left open under them
									// would be a second list behind the first. Only
									// when one is: shutting none draws the page again,
									// once, for a letter that changed nothing in it.
									if (panel !== null) setPanel(null);
								}}
								onChoose={openResult}
								sourceName={resultSourceName}
								showing={showing}
								searchOpen={searchOpen}
								onSearchOpen={setSearchOpen}
								fieldRef={searchField}
								onOrigins={setOrigins}
							/>
						) : (
							<SourceTabs
								returnTo={returnPath(href)}
								enterCode={enterCode}
								search={
									<NoteSearchField
										query={query}
										onQuery={setQuery}
										onChoose={openResult}
										sourceName={resultSourceName}
										showing={showing}
										fieldRef={searchField}
									/>
								}
							/>
						)
					}
				</SearchQuery>
				{/*
				 * Under the bar rather than over it: the bar is the top of the window
				 * to a compact window's search, which hangs from it to the foot.
				 */}
				<InstallBanner />
				{/*
				 * For as long as a detached source is the one showing, and not
				 * dismissable: its notes look like any others, can be opened and
				 * written in like any others, and sync nowhere. `role="note"` rather
				 * than `status`, as a standing remark about what is on screen and not
				 * news of something that has just happened.
				 */}
				{source?.detached !== undefined && (
					<p className="banner" role="note">
						{detachedText(source)}
					</p>
				)}
				{paletteOpen && (
					<CommandPalette
						onClose={() => {
							setPaletteOpen(false);
						}}
					/>
				)}

				{/* `data-panel` is which pane a compact window is showing as a
			    dropdown; the stylesheet ignores it in a wide one. */}
				<div className="app-shell" {...shellProps} {...scratch.shellProps(panel)}>
					{/* Positioned, like the two panes in a compact window, so it is
				    never a grid item and takes no column. */}
					<SourceDropdown
						compact={compact}
						enterCode={enterCode}
						renamings={renamings}
						returnTo={returnPath(href)}
						onChosen={() => {
							setPanel('notebooks');
						}}
					/>
					<Sidebar
						tree={tree}
						selectedFolder={folder}
						onSelectFolder={(path) => {
							openFolder(path, afterFolder(path));
						}}
						onCreateFolder={onCreateFolder}
						onRenameFolder={onRenameFolder}
						onDeleteFolder={onDeleteFolder}
						renamings={renamings}
						looseNoteCount={looseNoteCount}
						// In a compact window it is in the source dropdown instead,
						// which is where a phone user goes for anything about storage.
						{...(compact ? {} : { footer: <AccountPanel /> })}
						moving={moving}
						onPickUp={setMoving}
						onDrop={onDropInto}
						onCancelMove={cancelMove}
						onReveal={() => {
							if (compact) setPanel('notebooks');
						}}
						newNotebookAsked={newNotebookAsked}
						openNotebooks={openNotebooks}
						onOpenNotebooks={onOpenNotebooks}
						onPinFolder={(path, pin) => {
							if (activeConnection !== undefined)
								void setNotebookPin(db, activeConnection, path, pin);
						}}
						scratchpad={placeRow(scratchpadShown, inScratchpad, scratch.show)}
						passwords={placeRow(passwordsShown, inPasswords, passwords.show)}
					/>

					{inScratchpad ? (
						scratchPane()
					) : inPasswords ? (
						<Passwords
							items={passwords.items}
							selectedId={noteId}
							onSelect={passwords.choose}
							onAdd={passwords.add}
						/>
					) : (
						<NoteList
							notes={notes}
							renamings={renamings}
							selectedNoteId={noteId}
							// A note listed from a notebook inside the open one opens that
							// notebook with it, as a search result does: the sidebar then
							// lights the notebook the note is in.
							// Each a step with no dropdown over it, which shuts the notes.
							onSelectNote={(note) => {
								select({ folder: parentPath(note.path), note: note.id }, { note });
							}}
							onCreateNote={onCreateNote}
							onCreateNotebook={askNewNotebook}
							folderPath={folder}
							// Both queries, not just the tree: the notebooks alone cannot tell
							// an empty app from one whose notes all sit loose at the root.
							storeLoaded={tree !== undefined && looseNoteCount !== undefined}
							onPickUpNote={(note) => {
								setMoving({
									kind: 'note',
									id: note.id,
									path: note.path,
									name: titleShown(note.title),
								});
							}}
							onCancelMove={cancelMove}
							movingNoteId={moving?.kind === 'note' ? moving.id : undefined}
							unsavedNoteId={unsavedNoteId}
							liveEdits={liveEdits}
							// The note's own menu, about the note on the row its `⋯` or
							// a right-click is on, which need not be the one open. Delete goes through the note pane,
							// which holds what autosave has not stored yet.
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
													pickUp({
														kind: 'note',
														id: note.id,
														path: note.path,
														name: titleShown(note.title),
													});
												}
											: undefined,
									onDelete: () => {
										noteView.current?.deleteNote(note);
									},
								})
							}
						/>
					)}

					{noteColumn()}
				</div>

				{scratchOverlays()}

				{/*
				 * One stack for everything this screen floats over the page. Two
				 * notices at once is ordinary — a failed create while the account
				 * just connected is still being read — and in a stack they sit above
				 * one another instead of on one another.
				 *
				 * The undo notice is here rather than placing itself, which is what
				 * it did while it was the only other card on the screen.
				 */}
				<HeldImport source={held} />
				<TakeShare
					share={share}
					source={source}
					sources={sources}
					onRead={shareRead}
					onAdded={shareAdded}
				/>
				<div className="toast-stack">
					{deleted !== null && (
						<DeletedNotice
							// A second delete is a new notice with a new clock, not the
							// first one's time running on under another note's name.
							key={noteRef(deleted)}
							title={nameShown(deleted)}
							onUndo={undoDelete}
							onDismiss={dismissDeleted}
							keep={undoFailed === noteRef(deleted)}
						/>
					)}
					{connectNotice !== undefined && (
						<Toast
							message={connectNotice.message}
							tone={connectNotice.tone}
							action={connectNotice.action}
							onDismiss={dismissConnect}
						/>
					)}
					{problem !== null && (
						<Toast
							message={problem.message}
							tone={problem.tone}
							action={problem.action}
							onDismiss={dismissProblem}
						/>
					)}
					{told !== null && (
						<Toast
							message={told.message}
							tone={told.tone}
							action={told.action}
							onDismiss={dismissTold}
						/>
					)}
				</div>
			</div>
		</NotifyContext.Provider>
	);
};

/**
 * The provider wraps the shell rather than the app: every command belongs to a
 * mounted screen, so a registry with the same lifetime as the screen is one
 * that cannot hold a command whose `run` closes over a component that has gone.
 */
const HomeWithCommands = () => (
	<CommandsProvider>
		<Home />
	</CommandsProvider>
);

export const Route = createFileRoute('/')({
	validateSearch: parseSearch,
	component: HomeWithCommands,
	// Here as well as on the root so that the root's layout survives this screen
	// failing: the "new version" prompt lives there, and a build that throws on
	// render is exactly the one the user needs to be able to reload out of.
	errorComponent: ErrorScreen,
});
