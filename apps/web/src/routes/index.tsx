import { basename, ROOT, SCRATCHPAD_FOLDER, VAULT_FOLDER } from '@skysa/core';
import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';

import { CommandsProvider, useShortcuts } from '../commands/context.js';
import { AccountPanel, returnPath } from '../components/AccountPanel.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { ErrorScreen } from '../components/ErrorScreen.js';
import { HeldImport } from '../components/ImportProgress.js';
import { NoteView } from '../components/note/NoteView.js';
import type { NoteViewHandle, ScratchEditing } from '../components/note/types.js';
import type { Notice } from '../components/notify.js';
import { Passwords } from '../components/Passwords.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { usePasswords } from '../components/usePasswords.js';
import { useOpenWhenShown, useScratchpad } from '../components/useScratchpad.js';
import { useLatest } from '../hooks/useLatest.js';
import { t } from '../i18n/t.js';
import { TakeShare } from '../share/TakeShare.js';
import { db, noteRef } from '../store/db.js';
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
import { createLiveEdits } from '../store/liveEdits.js';
import { setNotebooksOpen } from '../store/openNotebooks.js';
import { setNotebookPin } from '../store/pins.js';
import { createRenamings } from '../store/renaming.js';
import { findFolder, notesUnder } from '../store/tree.js';
import { tabName } from '../sync/account.js';
import {
	useEnterCode,
	useKeepOnInstall,
	useShareArrival,
	useShellCommands,
} from './-home/commands.js';
import { useCodeAskedAgain, useConnectNotice } from './-home/connectNotice.js';
import { HomeBar } from './-home/HomeBar.js';
import { HomeLayout } from './-home/HomeLayout.js';
import { HomeToasts } from './-home/HomeToasts.js';
import { NoteColumn, PasswordColumn } from './-home/NoteColumn.js';
import { NotesPane } from './-home/NotesPane.js';
import { covered, emptyPaneOffers, placeRow } from './-home/rules.js';
import { ScratchOverlays, ScratchPane } from './-home/ScratchParts.js';
import { SourceDropdown } from './-home/SourceDropdown.js';
import { useBegunInView, useListedNotes } from './-home/useListedNotes.js';
import { useEscapePutsDown, useMoving } from './-home/useMoving.js';
import { useNotebookActions } from './-home/useNotebookActions.js';
import { canBegin, useOpenPlace } from './-home/useOpenPlace.js';
import { useSelect } from './-home/useSelect.js';
import { useUndoDelete } from './-home/useUndoDelete.js';
import { type Pane, useCompactLayout } from './panel.js';
import { parseSearch } from './search.js';

/**
 * The app. Which folder and note are open lives in the URL rather than in
 * component state — by path in the hash, by id in the history entry
 * (`place.ts`) — so reloading, following a link, or going Back or Forward
 * lands the user where it says; and on the device (`store/lastOpen.ts`), so
 * reopening the PWA at its start URL, or showing a source again, lands them
 * where they were. The matching is `-home/useOpenPlace.ts`.
 */

const Home = () => {
	const { connect, code, enter, share } = Route.useSearch();
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
	const { folder, noteId, openNote, storedNote, opening, go } = place;
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
	const { shareRead, shareAdded } = useShareArrival(compact, setPanel);
	const [paletteOpen, setPaletteOpen] = useState(false);
	/**
	 * The search field, so a command can put the cursor in it. A command that
	 * only *said* "search" and left the user to find the box would be a slower
	 * way of doing nothing.
	 */
	const searchField = useRef<HTMLInputElement>(null);

	const { select, openFolder, openResult } = useSelect({
		place,
		notes,
		activeConnection,
		setPanel,
		shutPanel,
		setSearchOpen,
		setProblem,
		dismissConnect,
	});

	const { deleted, noteDeleted, undoFailed, dismissDeleted, undoDelete, deletePassword } =
		useUndoDelete({ select, setProblem, noteIdRef });
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
		onDeleted: noteDeleted,
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

	useEscapePutsDown(moving, setMoving);

	useShellCommands({
		setPaletteOpen,
		onCreateNote,
		scratchModal: scratch.modal,
		setSearchOpen,
		searchField,
		connectionId: activeConnection,
		source,
		setProblem,
		deleted,
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
				noteDeleted(note, displaced);
				scratch.deleted(note);
			}}
		/>
	);

	return (
		<HomeLayout
			notify={setTold}
			frameClassName={frameClassName}
			inert={covered(held, scratch.modal)}
			source={source}
			shell={{ ...shellProps, ...scratch.shellProps(panel) }}
			bar={
				<HomeBar
					compact={compact}
					returnTo={returnPath(href)}
					enterCode={enterCode}
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
					onChoose={openResult}
					sourceName={resultSourceName}
					showing={showing}
					searchOpen={searchOpen}
					onSearchOpen={setSearchOpen}
					fieldRef={searchField}
					onOrigins={setOrigins}
				/>
			}
			palette={
				paletteOpen && (
					<CommandPalette
						onClose={() => {
							setPaletteOpen(false);
						}}
					/>
				)
			}
			sourceDropdown={
				<SourceDropdown
					compact={compact}
					enterCode={enterCode}
					renamings={renamings}
					returnTo={returnPath(href)}
					onChosen={() => {
						setPanel('notebooks');
					}}
				/>
			}
			sidebar={
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
			}
			list={
				inScratchpad ? (
					<ScratchPane scratch={scratch} liveEdits={liveEdits} editor={noteEditor} />
				) : inPasswords ? (
					<Passwords
						items={passwords.items}
						selectedId={noteId}
						onSelect={passwords.choose}
						onAdd={passwords.add}
					/>
				) : (
					<NotesPane
						notes={notes}
						renamings={renamings}
						selectedNoteId={noteId}
						folderPath={folder}
						select={select}
						onCreateNote={onCreateNote}
						onCreateNotebook={askNewNotebook}
						// Both queries, not just the tree: the notebooks alone cannot tell
						// an empty app from one whose notes all sit loose at the root.
						storeLoaded={tree !== undefined && looseNoteCount !== undefined}
						setMoving={setMoving}
						cancelMove={cancelMove}
						moving={moving}
						pickUp={pickUp}
						unsavedNoteId={unsavedNoteId}
						liveEdits={liveEdits}
						pins={pins}
						deleteNote={(note) => {
							noteView.current?.deleteNote(note);
						}}
					/>
				)
			}
			note={
				inPasswords ? (
					<PasswordColumn
						openNote={openNote}
						opening={opening}
						compact={compact}
						draft={place.noteDraft}
						onProblem={setProblem}
						onDelete={deletePassword}
						// Not `select`, which would take down what the item had to
						// say: why a new one could not be begun.
						onClose={() => {
							go({ folder: VAULT_FOLDER }, { replace: true, notePath: undefined });
						}}
						onOpen={(note) => {
							select(
								{ folder: VAULT_FOLDER, note: note.id },
								{ replace: true, note }
							);
						}}
					/>
				) : (
					<NoteColumn
						inScratchpad={inScratchpad}
						compact={compact}
						cardId={scratch.card?.id}
						unseen={panel !== null}
						editing={scratch.editing}
						editor={noteEditor}
					/>
				)
			}
			overlays={<ScratchOverlays scratch={scratch} editor={noteEditor} />}
			// One stack for everything this screen floats over the page. Two
			// notices at once is ordinary — a failed create while the account
			// just connected is still being read — and in a stack they sit above
			// one another instead of on one another.
			//
			// The undo notice is here rather than placing itself, which is what
			// it did while it was the only other card on the screen.
			floating={
				<>
					<HeldImport source={held} />
					<TakeShare
						share={share}
						source={source}
						sources={sources}
						onRead={shareRead}
						onAdded={shareAdded}
					/>
					<HomeToasts
						deleted={deleted}
						undoDelete={undoDelete}
						dismissDeleted={dismissDeleted}
						undoFailed={undoFailed}
						connectNotice={connectNotice}
						dismissConnect={dismissConnect}
						problem={problem}
						dismissProblem={dismissProblem}
						told={told}
						dismissTold={dismissTold}
					/>
				</>
			}
		/>
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
