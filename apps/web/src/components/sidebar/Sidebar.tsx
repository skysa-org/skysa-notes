import { ancestorPaths, basename, isScratchPath, isVaultPath, ROOT } from '@skysa/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import type { NotebookPin } from '../../store/pins.js';
import type { Moving } from '../../store/rearrange.js';
import { SCRATCHPAD_LABEL } from '../../store/scratchpad.js';
import { type FolderNode, notesUnder } from '../../store/tree.js';
import { PASSWORDS_LABEL } from '../../store/vault.js';
import { AttachedFiles } from '../attachments/AttachedFiles.js';
import { Icon, type IconName } from '../ui/icons.js';
import { FloatingMenu } from '../ui/OptionsMenu.js';
import { TreeBody } from './FolderTree.js';
import { DeleteConfirm, MoveHint, NewFolderField } from './NotebookFields.js';
import { useNotebookMenu } from './useNotebookMenu.js';

/**
 * The notebook tree. Folders are real directories on the provider, so this is a
 * view of the user's actual directory structure, not an app-only abstraction.
 *
 * Only notebooks are listed. The root is where notebooks live, not a notebook
 * itself, so it has no row of its own — except when it actually holds notes,
 * which a remote folder can arrive already doing. Then one row appears below
 * the notebooks and names exactly what it holds. It is not the "All notes" row
 * we removed: that one always showed and misdescribed its contents.
 *
 * A notebook can be dragged into another, and a note can be dragged out of the
 * list beside it and into one. While either is in the air every row here is a
 * destination rather than a place to go, which is the whole of the mode: see
 * `MoveHint` (`NotebookFields.tsx`) for why it is also reachable without a pointer.
 *
 * The header makes a notebook at the **top level**, always, and everything
 * else that can be done to one — a notebook inside it, a rename, a move, a
 * delete — is behind the `\u22ef` beside it and is about the open notebook.
 * The `+` used to put the new notebook inside whichever was open, which meant
 * that with anything open there was no way to make a top-level one at all: the
 * only route to the top level was to have nothing selected, which the app
 * arranges only when there are no notebooks. Nesting is the rarer thing and it
 * now has two ways of its own to be asked for, so the common one is the one
 * that is unconditional.
 *
 * A notebook with notebooks inside it lists them only while it is open, which
 * it is once the user has opened it and stays on this device
 * (`store/openNotebooks.ts`). A library brought in from elsewhere can be
 * hundreds of notebooks nested three deep, and listed whole it was a column
 * to scroll through to find anything. A notebook counts every note inside
 * it, at every depth, open or shut, as its list shows them all (`listedUnder`).
 */

export interface SidebarProps {
	tree: FolderNode[] | undefined;
	/** Undefined until the tree has loaded, and when there are no notebooks. */
	selectedFolder: string | undefined;
	onSelectFolder: (path: string) => void;
	/** `undefined` for the top level, which is what the header's `+` asks for. */
	onCreateFolder: (parentPath: string | undefined, name: string) => void;
	/** Rename in place. The name is a single segment, not a path. */
	onRenameFolder?: (path: string, name: string) => void;
	/** Delete the notebook and everything in it. Asked about first. */
	onDeleteFolder?: (path: string) => void;
	/**
	 * Notes sitting at the root, in no notebook. Undefined while loading; zero
	 * in the normal case, and then there is no row.
	 */
	looseNoteCount: number | undefined;
	/** Below the tree: where the storage account lives. */
	footer?: ReactNode;
	/**
	 * What is being moved, or null. Held by the route rather than here because
	 * a note is picked up in the pane next door and put down in this one.
	 */
	moving?: Moving | null;
	/** A drag started on a notebook row. */
	onPickUp?: (moving: Moving) => void;
	/** Put what is being moved into this folder. `ROOT` is the top level. */
	onDrop?: (into: string) => void;
	/** The drag ended without a drop, or Escape was pressed. */
	onCancelMove?: () => void;
	/**
	 * Something here has just started that needs the user's eyes — a rename or
	 * a delete asked for from the palette. In a compact window the sidebar is a
	 * dropdown and may be shut, and a field focused inside a shut panel takes
	 * no keystrokes at all.
	 */
	onReveal?: () => void;
	/**
	 * Counts the times something outside the sidebar asked for a new top-level
	 * notebook: the note list's "Create a notebook", for one. A count, not a
	 * flag, so asking twice opens the field twice. The field and what it
	 * holds stay the sidebar's own.
	 */
	newNotebookAsked?: number;
	/**
	 * The notebooks whose notebooks are listed. `undefined` until it has been
	 * read, when every notebook is shut, as one nobody has opened is.
	 */
	openNotebooks?: ReadonlySet<string>;
	/** Open or shut these notebooks. */
	onOpenNotebooks?: (paths: string[], open: boolean) => void;
	/**
	 * Pin a notebook to the top or the bottom of its level, or unpin it
	 * (`undefined`). Which are pinned is in the tree (`withPins`), which comes
	 * in that order.
	 */
	onPinFolder?: (path: string, pin: NotebookPin | undefined) => void;
	/**
	 * The source's scratchpad (docs/ARCHITECTURE.md §7, "The scratchpad"), a
	 * row above the notebooks while this device shows it: open or not, and the
	 * way to open it.
	 */
	scratchpad?: { selected: boolean; onSelect: () => void } | undefined;
	/**
	 * The source's passwords (docs/ARCHITECTURE.md §7, "Passwords in the
	 * vault"), a row under the notebooks while this device shows them.
	 */
	passwords?: { selected: boolean; onSelect: () => void } | undefined;
}

/**
 * The notebook the palette's commands are about, of the folder selected. The
 * root is selectable while it holds loose notes and is not a notebook: it
 * cannot be renamed, moved or deleted, and a notebook made "inside" it is a
 * top-level one anyway. Nor is the scratchpad one, or the passwords.
 */
const notebookOpen = (selectedFolder: string | undefined): string | undefined =>
	selectedFolder === undefined ||
	selectedFolder === ROOT ||
	isScratchPath(selectedFolder) ||
	isVaultPath(selectedFolder)
		? undefined
		: selectedFolder;

/**
 * The row of a place that is no notebook: the scratchpad's, above the
 * notebooks, and the passwords', under them. Not one of the notebooks, so it is
 * never a place to put something being moved, and is not offered while
 * something is. As tall as the headings at the top of the other columns, so the
 * rules under the scratchpad's line up across the window.
 */
const PlaceRow = ({
	className,
	icon,
	label,
	selected,
	onSelect,
	moving,
}: {
	className: string;
	icon: IconName;
	label: string;
	selected: boolean;
	onSelect: () => void;
	moving: boolean;
}) => (
	<div className={`place-row ${className}`}>
		<button
			type="button"
			className={selected ? 'row selected' : 'row'}
			aria-current={selected ? 'true' : undefined}
			disabled={moving}
			onClick={onSelect}
		>
			<Icon name={icon} />
			<span className="row-label">{label}</span>
		</button>
	</div>
);

/** How long something dragged rests on a shut notebook before it opens. */
const DWELL_MS = 600;
/** Longer than this between two `dragover`s, and it had gone and come back. */
const DWELL_GAP_MS = 600;

/**
 * A shut notebook opens under something dragged that rests on it, as a
 * folder does in a file manager: before there was a chevron, every notebook
 * was a place to drop, and a drag has no hand free to press one. Counted by
 * the `dragover`s a browser sends while the pointer is there, moving or not,
 * so there is no timer to cancel.
 */
const useDwell = (open: (path: string) => void) => {
	const dwell = useRef<{ path: string; since: number; seen: number } | null>(null);
	return (path: string) => {
		const now = Date.now();
		const last = dwell.current;
		const since =
			last !== null && last.path === path && now - last.seen < DWELL_GAP_MS
				? last.since
				: now;
		if (now - since >= DWELL_MS) {
			dwell.current = null;
			open(path);
			return;
		}
		dwell.current = { path, since, seen: now };
	};
};

/** Notebooks opened, by whoever keeps which are open. */
const opener =
	(onOpenNotebooks: ((paths: string[], open: boolean) => void) | undefined) =>
	(...paths: string[]) => {
		onOpenNotebooks?.(paths, true);
	};

/** One notebook opened or shut, by whoever keeps which are open. */
const toggleWith =
	(onOpenNotebooks: ((paths: string[], open: boolean) => void) | undefined) =>
	(path: string, open: boolean) => {
		onOpenNotebooks?.([path], open);
	};

/** Every file beneath a notebook, which deleting it takes as well. */
const filesUnder = (node: FolderNode): number =>
	node.children.reduce((total, child) => total + filesUnder(child), node.fileCount);

/**
 * The notebook open in the note list is shown in the sidebar too: when one is
 * opened — from the URL, from where the user was, from a search or a palette
 * command, or made — the notebooks it is in are opened. Once for each, so
 * shutting one of them afterwards is the user's to do, and done.
 */
const useRevealed = (
	selectedFolder: string | undefined,
	openNotebooks: ReadonlySet<string> | undefined,
	onOpenNotebooks: ((paths: string[], open: boolean) => void) | undefined
) => {
	const revealed = useRef<string | undefined>(undefined);
	useEffect(() => {
		// Not read yet, for this source: a source shown in place of another has
		// a set of its own, which the notebook open there has to be revealed in
		// too, though its path may be the one revealed in the last.
		if (openNotebooks === undefined) {
			revealed.current = undefined;
			return;
		}
		if (selectedFolder === undefined || selectedFolder === ROOT) return;
		if (revealed.current === selectedFolder) return;
		revealed.current = selectedFolder;
		const shut = ancestorPaths(selectedFolder).filter((path) => !openNotebooks.has(path));
		if (shut.length > 0) onOpenNotebooks?.(shut, true);
	}, [selectedFolder, openNotebooks, onOpenNotebooks]);
};

export const Sidebar = ({
	tree,
	selectedFolder,
	onSelectFolder,
	onCreateFolder,
	onRenameFolder,
	onDeleteFolder,
	looseNoteCount,
	footer,
	moving = null,
	onPickUp,
	onDrop,
	onCancelMove,
	onReveal,
	newNotebookAsked = 0,
	openNotebooks,
	onOpenNotebooks,
	onPinFolder,
	scratchpad,
	passwords,
}: SidebarProps) => {
	/** Where a notebook is being made, or null. `undefined` is the top level. */
	const [creating, setCreating] = useState<{ parent: string | undefined } | null>(null);

	// Asked for from outside: the field opens as it does for the header's `+`.
	// Adjusted during render rather than in an effect, as React has it for state
	// that follows a prop.
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
	const [answeredAsk, setAnsweredAsk] = useState(newNotebookAsked);
	if (newNotebookAsked !== answeredAsk) {
		setAnsweredAsk(newNotebookAsked);
		if (moving === null) setCreating({ parent: undefined });
	}
	/** Which row the pointer is over, for the highlight and nothing else. */
	const [over, setOver] = useState<string | null>(null);

	useRevealed(selectedFolder, openNotebooks, onOpenNotebooks);
	const openThese = opener(onOpenNotebooks);
	const dwell = useDwell(openThese);

	const pickUp = onPickUp ?? (() => undefined);
	const drop = onDrop ?? (() => undefined);
	const cancel = onCancelMove ?? (() => undefined);

	/** The notebook the palette's commands are about (`notebookOpen`). */
	const open = notebookOpen(selectedFolder);
	const {
		renaming,
		typed,
		renamed,
		deleting,
		going,
		confirmDelete,
		stopDeleting,
		listing,
		stopListing,
		menu,
		openMenu,
		closeMenu,
		itemsFor,
	} = useNotebookMenu({
		tree,
		open,
		moving,
		pickUp,
		openThese,
		onNewInside: (path) => {
			setCreating({ parent: path });
		},
		onRenameFolder,
		onDeleteFolder,
		onPinFolder,
		onReveal,
	});

	return (
		<nav className="sidebar" aria-label={t('notebooks.title')}>
			{scratchpad !== undefined && (
				<PlaceRow
					className="scratchpad-row"
					icon="scratchpad"
					label={SCRATCHPAD_LABEL}
					selected={scratchpad.selected}
					onSelect={scratchpad.onSelect}
					moving={moving !== null}
				/>
			)}
			<div className="pane-header">
				<h2>{t('notebooks.title')}</h2>
				<div className="pane-actions">
					<button
						type="button"
						className="icon"
						// Unconditionally the top level. What the `+` in a pane
						// header makes is a notebook, and the top level is where
						// notebooks live; anywhere else is asked for by name.
						title={t('notebooks.newNotebook')}
						aria-label={t('notebooks.newNotebook')}
						// A move is a mode, and a notebook made in the middle of one
						// would land in a tree the user is holding a piece of.
						disabled={moving !== null}
						onClick={() => {
							setCreating({ parent: undefined });
						}}
					>
						+
					</button>
				</div>
			</div>

			{moving !== null && <MoveHint moving={moving} onCancel={cancel} />}

			{creating !== null && (
				<NewFolderField
					parentPath={creating.parent}
					onCancel={() => {
						setCreating(null);
					}}
					onSubmit={(name) => {
						const parent = creating.parent;
						setCreating(null);
						onCreateFolder(parent, name);
					}}
				/>
			)}

			{listing !== null && (
				<AttachedFiles name={basename(listing)} path={listing} onClose={stopListing} />
			)}

			{deleting !== null && (
				<DeleteConfirm
					name={basename(deleting)}
					noteCount={going === undefined ? 0 : notesUnder(going)}
					fileCount={going === undefined ? 0 : filesUnder(going)}
					onConfirm={confirmDelete}
					onCancel={stopDeleting}
				/>
			)}

			<TreeBody
				tree={tree}
				looseNoteCount={looseNoteCount}
				onCreate={() => {
					setCreating({ parent: undefined });
				}}
				selectedFolder={selectedFolder}
				onSelectFolder={onSelectFolder}
				moving={moving}
				over={over}
				onOver={setOver}
				onPickUp={pickUp}
				onDrop={drop}
				onCancelMove={cancel}
				renaming={renaming}
				onDraft={typed}
				onRenamed={renamed}
				onMenu={openMenu}
				itemsFor={itemsFor}
				openNotebooks={openNotebooks}
				onToggle={toggleWith(onOpenNotebooks)}
				onDwell={dwell}
			/>

			{menu !== null && (
				<FloatingMenu
					at={menu.at}
					label={t('rows.notebook.menu', { name: basename(menu.of) })}
					items={itemsFor(menu.of)}
					onClose={closeMenu}
				/>
			)}

			{passwords !== undefined && (
				<PlaceRow
					className="passwords-row"
					icon="key"
					label={PASSWORDS_LABEL}
					selected={passwords.selected}
					onSelect={passwords.onSelect}
					moving={moving !== null}
				/>
			)}

			{footer}
		</nav>
	);
};
