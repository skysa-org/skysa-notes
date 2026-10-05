import { ancestorPaths, basename, ROOT } from '@skysa/core';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { useCommand } from '../commands/context.js';
import { Icon } from '../editor/icons.js';
import { canDrop, type Moving } from '../store/rearrange.js';
import { type Renamings } from '../store/renaming.js';
import { type FolderNode, LOOSE_NOTES_LABEL } from '../store/tree.js';
import { AttachedFiles } from './AttachedFiles.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { type NotebookActions, notebookMenuItems } from './NotebookMenu.js';
import { FloatingMenu, type MenuPoint, menuPoint, type OptionsMenuItem } from './OptionsMenu.js';
import { RowOptions } from './RowOptions.js';
import { rowIndent, RowRename } from './RowRename.js';

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
 * `MoveHint` below for why it is also reachable without a pointer.
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
 * to scroll through to find anything. Shut, a notebook counts every note
 * inside it, so the number says what is behind it.
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
	/** Where a name being typed is told, for what else on screen shows it. */
	renamings?: Renamings;
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
	 * Pin a notebook to the top of its level, or unpin it. Which are pinned is
	 * in the tree (`withPins`), which comes in that order.
	 */
	onPinFolder?: (path: string, pinned: boolean) => void;
}

/**
 * Inline rather than a `prompt()`: a modal browser dialog blocks the page, is
 * unstyleable, and behaves badly in an installed PWA.
 */
interface NewFolderFieldProps {
	/** Where the notebook will go, or undefined for the top level. */
	parentPath: string | undefined;
	onCancel: () => void;
	onSubmit: (name: string) => void;
}

const NewFolderField = ({ parentPath, onCancel, onSubmit }: NewFolderFieldProps) => {
	const [name, setName] = useState('');
	const field = useRef<HTMLInputElement>(null);

	// The field appears in response to a click, so moving focus into it is what
	// the user asked for — unlike `autoFocus` on page load, which jsx-a11y
	// rightly rejects. A keyboard user would otherwise have to hunt for the
	// field they just opened.
	useEffect(() => {
		field.current?.focus();
	}, []);

	const submit = () => {
		const trimmed = name.trim();
		if (trimmed === '') {
			onCancel();
			return;
		}
		onSubmit(trimmed);
	};

	return (
		<input
			className="new-folder"
			// The field is in the header wherever the notebook is going, so where
			// that is has to be in the words: the two cases are one keystroke
			// apart and land in different places.
			aria-label={
				parentPath === undefined
					? 'New notebook name'
					: `Name for a notebook inside \u201c${basename(parentPath)}\u201d`
			}
			placeholder={
				parentPath === undefined
					? 'Notebook name'
					: `Inside \u201c${basename(parentPath)}\u201d`
			}
			ref={field}
			value={name}
			onChange={(event) => {
				setName(event.target.value);
			}}
			onBlur={submit}
			onKeyDown={(event) => {
				if (event.key === 'Enter') submit();
				if (event.key === 'Escape') onCancel();
			}}
		/>
	);
};

/**
 * What the sidebar says while something is in the air, and the reason the
 * dragging is not the only way to do this.
 *
 * Dragging is a pointer gesture, and WCAG 2.2 asks that anything it can do be
 * doable with a single pointer that does not drag (SC 2.5.7) — a keyboard user
 * and a user with a tremor both need the same moves. The answer here is that
 * picking up is a *command* (`notebook.move`, `note.move` in the route, so they
 * are in the palette like everything else — docs/ARCHITECTURE.md §7, "Commands are
 * declared, not collected") and putting down is a click on the destination row.
 * That is the same mode a drag enters, so there is one implementation and not
 * two: `moving` is set by the command or by `dragstart`, and read here and by
 * every row below without either of them knowing which it was.
 */
const MoveHint = ({ moving, onCancel }: { moving: Moving; onCancel: () => void }) => (
	<p className="move-hint">
		{/* The live region is the sentence alone: the way out is a control to
		    reach, not news to be read out every time the hint changes. Escape
		    still puts the thing down too (the route listens for it). */}
		<span role="status">{`Moving “${moving.name}”. Choose where to put it.`}</span>{' '}
		<button type="button" className="link-button" onClick={onCancel}>
			Cancel
		</button>
	</p>
);

/**
 * A row's label while a move is on. Said outright rather than left to be read
 * off the row, which by then says the wrong thing: "Work" is where the user
 * would go, and during a move it is where the thing they are holding lands.
 */
const destinationLabel = (
	moving: Moving,
	name: string,
	landing: string | undefined,
	allowed: boolean
): string =>
	allowed ? `Move “${moving.name}” ${landing ?? `into ${name}`}` : `${name} — cannot go here`;

const howMany = (count: number, one: string, many: string): string[] =>
	count === 0 ? [] : [`${String(count)} ${count === 1 ? one : many}`];

/**
 * What deleting a notebook takes, in words. The files too: a file beside a note
 * is deleted with its notebook and in no other way (#187), so this is the one
 * place the user is told it will go.
 */
const deletionOf = (name: string, noteCount: number, fileCount: number): string => {
	const going = [...howMany(noteCount, 'note', 'notes'), ...howMany(fileCount, 'file', 'files')];
	return going.length === 0
		? `\u201c${name}\u201d will be deleted.`
		: `\u201c${name}\u201d and the ${going.join(' and ')} in it will be deleted.`;
};

/**
 * Asked before a notebook goes, and not told afterwards — the rule the
 * disconnect confirm exists for (docs/ARCHITECTURE.md §10), and the reason a notebook
 * needs one where a note does not: a note comes back from the notice that
 * follows it, and a notebook takes every note beneath it with it. So the count
 * is in the question, because that is the part the user may not know.
 *
 * Over the page rather than wedged under the pane header, where it pushed the
 * tree down and read as a row of it (`ConfirmDialog`).
 */
const DeleteConfirm = ({
	name,
	noteCount,
	fileCount,
	onConfirm,
	onCancel,
}: {
	name: string;
	noteCount: number;
	fileCount: number;
	onConfirm: () => void;
	onCancel: () => void;
}) => (
	<ConfirmDialog
		title="Delete notebook?"
		confirmLabel="Delete"
		tone="danger"
		onConfirm={onConfirm}
		onCancel={onCancel}
	>
		{deletionOf(name, noteCount, fileCount)}
	</ConfirmDialog>
);

interface RowProps {
	/** `ROOT` for the top level and for the loose notes. */
	path: string;
	name: string;
	/**
	 * Where the thing lands, in words, when "into <name>" is not how to say it.
	 * The top level is a place rather than a notebook: things go *to* it.
	 */
	landing?: string;
	selected: boolean;
	depth: number;
	count?: number;
	moving: Moving | null;
	over: string | null;
	onOver: (path: string | null) => void;
	onSelect: () => void;
	onDrop: (into: string) => void;
	/** Missing on a row that stands for a place rather than for a notebook. */
	onPickUp?: () => void;
	onCancelMove: () => void;
	/** A right-click: the notebook's menu, where it has one. */
	onMenu?: (at: MenuPoint) => void;
	/** Left and Right, which open and shut a notebook (`treeKeys`). */
	onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
	/**
	 * Whether the notebooks inside it are listed, for one that has any: said
	 * on the row, the tab stop, so a screen reader tabbing down the list hears
	 * that something is inside and whether it is showing.
	 */
	expanded?: boolean;
	/** Pinned to the top of its level on this device (`store/pins.ts`). */
	pinned?: boolean;
}

/**
 * One row, whichever list it is in, because a destination is a destination: the
 * loose notes and the top level get the same refusals and the same highlight as
 * a notebook does, and three copies of that would drift.
 */
const Row = ({
	path,
	name,
	landing,
	selected,
	depth,
	count,
	moving,
	over,
	onOver,
	onSelect,
	onDrop,
	onPickUp,
	onCancelMove,
	onMenu,
	onKeyDown,
	expanded,
	pinned = false,
}: RowProps) => {
	const pinId = useId();
	const allowed = moving !== null && canDrop(moving, path);
	const classes = [
		'row',
		pinned ? 'pinned' : undefined,
		selected && moving === null ? 'selected' : undefined,
		moving?.kind === 'notebook' && moving.path === path ? 'moving' : undefined,
		allowed && over === path ? 'drop-over' : undefined,
	].filter((each) => each !== undefined);

	return (
		<button
			type="button"
			className={classes.join(' ')}
			style={{ paddingInlineStart: rowIndent(depth) }}
			// A row nothing can land on is not a destination, and saying so with
			// `disabled` also takes it out of the tab order for the length of the
			// move — a keyboard user stepping through destinations should not have
			// to step over the one they are holding.
			disabled={moving !== null && !allowed}
			aria-label={
				moving === null ? undefined : destinationLabel(moving, name, landing, allowed)
			}
			aria-current={selected && moving === null ? 'true' : undefined}
			aria-expanded={expanded}
			// Said beside the name rather than in it, which is what the row is
			// found by, and in words as well as the tint (`.row.pinned`).
			aria-describedby={pinned ? pinId : undefined}
			draggable={onPickUp !== undefined}
			onContextMenu={(event) => {
				// The browser's own menu where this row has none of its own: the
				// loose notes, the top level, and every row while a move is on.
				if (onMenu === undefined || moving !== null) return;
				event.preventDefault();
				onMenu(menuPoint(event));
			}}
			onClick={() => {
				if (moving === null) onSelect();
				else onDrop(path);
			}}
			onKeyDown={onKeyDown}
			onDragStart={(event) => {
				if (onPickUp === undefined) return;
				// Firefox starts no drag at all without data on it, and the string
				// is what another application would receive if the note were
				// dropped outside the window.
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('text/plain', name);
				onPickUp();
			}}
			onDragEnd={onCancelMove}
			onDragOver={(event) => {
				// `preventDefault` is what makes a drop possible at all, so it is
				// also how a row refuses one: without it the pointer shows "no".
				if (!allowed) return;
				event.preventDefault();
				onOver(path);
			}}
			onDragLeave={() => {
				onOver(null);
			}}
			onDrop={(event) => {
				if (!allowed) return;
				event.preventDefault();
				onOver(null);
				onDrop(path);
			}}
		>
			<span className="row-label">{name}</span>
			{count !== undefined && count > 0 && <span className="count">{count}</span>}
			{pinned && (
				<span id={pinId} hidden>
					Pinned
				</span>
			)}
		</button>
	);
};

/** Every live note beneath a notebook, which is what deleting it would take. */
const notesUnder = (node: FolderNode): number =>
	node.children.reduce((total, child) => total + notesUnder(child), node.noteCount);

interface DisclosureProps {
	path: string;
	name: string;
	depth: number;
	open: boolean;
	onToggle: () => void;
	moving: Moving | null;
	onOver: (path: string | null) => void;
	onDrop: (into: string) => void;
}

/**
 * The chevron that opens and shuts a notebook with notebooks inside it, in
 * the room before its name. Out of the tab order: the row is the stop, and
 * Left and Right on it do what this does, as in any tree of folders, so a
 * keyboard does not take two stops a notebook. Still a button with a name
 * and a state, for a screen reader's list of them and for a pointer.
 *
 * Except while something is being moved, when it is a stop of its own: the
 * row may then be no destination, and disabled — the notebook a note is
 * already in — and the destination the user wants is inside it. And it is a
 * piece of the row to drop on, as the row's start was before it was there.
 */
const Disclosure = ({
	path,
	name,
	depth,
	open,
	onToggle,
	moving,
	onOver,
	onDrop,
}: DisclosureProps) => {
	const allowed = moving !== null && canDrop(moving, path);
	return (
		<button
			type="button"
			className="row-disclosure"
			tabIndex={moving === null ? -1 : 0}
			aria-expanded={open}
			aria-label={`Notebooks inside \u201c${name}\u201d`}
			style={{
				insetInlineStart: `calc(var(--gutter) - var(--disclosure-reach) + ${String(depth * 0.85)}rem)`,
			}}
			onClick={onToggle}
			onDragOver={(event) => {
				if (!allowed) return;
				event.preventDefault();
				onOver(path);
			}}
			onDrop={(event) => {
				if (!allowed) return;
				event.preventDefault();
				onOver(null);
				onDrop(path);
			}}
		>
			<Icon name="chevron" />
		</button>
	);
};

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

/**
 * Left and Right on a notebook's row, as a tree of folders has them: Right
 * opens a shut notebook and goes into an open one, to the first notebook
 * inside it; Left shuts an open one and goes out of any other, to the
 * notebook it is in.
 */
const treeKeys =
	(hasChildren: boolean, open: boolean, toggle: (open: boolean) => void) =>
	(event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		// Alt and Command with an arrow are the browser's Back and Forward.
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const item = event.currentTarget.closest('li');
		if (event.key === 'ArrowRight') {
			if (!hasChildren) return;
			event.preventDefault();
			if (open) item?.querySelector<HTMLButtonElement>(':scope > ul button.row')?.focus();
			else toggle(true);
			return;
		}
		event.preventDefault();
		if (open) {
			toggle(false);
			return;
		}
		item?.parentElement
			?.closest('li')
			?.querySelector<HTMLButtonElement>(':scope > .row-item > button.row')
			?.focus();
	};

interface FolderRowsProps {
	nodes: FolderNode[];
	depth: number;
	selectedFolder: string | undefined;
	onSelectFolder: (path: string) => void;
	moving: Moving | null;
	over: string | null;
	onOver: (path: string | null) => void;
	onPickUp: (moving: Moving) => void;
	onDrop: (into: string) => void;
	onCancelMove: () => void;
	/** The notebook whose name is being typed, if one is. */
	renaming: string | null;
	/** Each keystroke in its name, for what else shows it. */
	onDraft: (path: string, text: string) => void;
	onRenamed: (path: string, chosen?: string) => void;
	/** A notebook's row was right-clicked. */
	onMenu: (path: string, at: MenuPoint) => void;
	/** What its `⋯` and its right-click offer. */
	itemsFor: (path: string) => OptionsMenuItem[];
	/** The notebooks whose notebooks are listed. */
	openNotebooks: ReadonlySet<string>;
	onToggle: (path: string, open: boolean) => void;
	/** Something dragged is over a shut notebook (`useDwell`). */
	onDwell: (path: string) => void;
}

const FolderRows = ({
	nodes,
	depth,
	selectedFolder,
	onSelectFolder,
	moving,
	over,
	onOver,
	onPickUp,
	onDrop,
	onCancelMove,
	renaming,
	onDraft,
	onRenamed,
	onMenu,
	itemsFor,
	openNotebooks,
	onToggle,
	onDwell,
}: FolderRowsProps) => (
	<>
		{nodes.map((node) => {
			const hasChildren = node.children.length > 0;
			const open = hasChildren && openNotebooks.has(node.path);
			const toggle = (to: boolean) => {
				onToggle(node.path, to);
			};
			// Shut, it counts what it holds at every depth: the notes that are
			// in it and the ones it hides.
			const count = hasChildren && !open ? notesUnder(node) : node.noteCount;
			return (
				<li key={node.path}>
					<div
						className="row-item"
						// On the row's box rather than its button, which may be
						// disabled for the move, and then is not where the pointer lands.
						onDragOver={
							moving !== null && hasChildren && !open
								? () => {
										onDwell(node.path);
									}
								: undefined
						}
					>
						{hasChildren && (
							<Disclosure
								path={node.path}
								name={node.name}
								depth={depth}
								open={open}
								onToggle={() => {
									toggle(!open);
								}}
								moving={moving}
								onOver={onOver}
								onDrop={onDrop}
							/>
						)}
						{node.path === renaming ? (
							<RowRename
								name={node.name}
								depth={depth}
								selected={node.path === selectedFolder}
								count={count}
								onDraft={(text) => {
									onDraft(node.path, text);
								}}
								onDone={(chosen) => {
									onRenamed(node.path, chosen);
								}}
							/>
						) : (
							<Row
								path={node.path}
								name={node.name}
								selected={node.path === selectedFolder}
								depth={depth}
								count={count}
								moving={moving}
								over={over}
								onOver={onOver}
								onSelect={() => {
									onSelectFolder(node.path);
								}}
								onDrop={onDrop}
								onPickUp={() => {
									onPickUp({
										kind: 'notebook',
										path: node.path,
										name: node.name,
									});
								}}
								onCancelMove={onCancelMove}
								onMenu={(at) => {
									onMenu(node.path, at);
								}}
								onKeyDown={treeKeys(hasChildren, open, toggle)}
								expanded={hasChildren ? open : undefined}
								pinned={node.pinned === true}
							/>
						)}
						{/* Not while its name is being typed, when the row is a field;
				    nor while something is being moved, when the rows are only
				    places to put it. */}
						{node.path !== renaming && (
							<RowOptions
								name={node.name}
								kind="Notebook"
								items={itemsFor(node.path)}
								disabled={moving !== null}
								// Rightwards, over the note list: the sidebar is at the
								// window's left edge, and a card opened leftwards from its
								// end has a sidebar's width to fit in.
								align="start"
							/>
						)}
					</div>
					{open && (
						<ul>
							<FolderRows
								nodes={node.children}
								depth={depth + 1}
								selectedFolder={selectedFolder}
								onSelectFolder={onSelectFolder}
								moving={moving}
								over={over}
								onOver={onOver}
								onPickUp={onPickUp}
								onDrop={onDrop}
								onCancelMove={onCancelMove}
								renaming={renaming}
								onDraft={onDraft}
								onRenamed={onRenamed}
								onMenu={onMenu}
								itemsFor={itemsFor}
								openNotebooks={openNotebooks}
								onToggle={onToggle}
								onDwell={onDwell}
							/>
						</ul>
					)}
				</li>
			);
		})}
	</>
);

/** No notebook open, which is how every one starts. */
const NONE_OPEN: ReadonlySet<string> = new Set();

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

/** The top level of the tree, which has no row of its own until one is needed. */
const TOP_LEVEL_LABEL = 'Top level';

/** Every file beneath a notebook, which deleting it takes as well. */
const filesUnder = (node: FolderNode): number =>
	node.children.reduce((total, child) => total + filesUnder(child), node.fileCount);

const nodeAt = (nodes: readonly FolderNode[], path: string): FolderNode | undefined =>
	nodes.reduce<FolderNode | undefined>(
		(found, node) => found ?? (node.path === path ? node : nodeAt(node.children, path)),
		undefined
	);

interface TreeBodyProps extends Omit<FolderRowsProps, 'nodes' | 'depth' | 'openNotebooks'> {
	/** Undefined until read, when every notebook is shut. */
	openNotebooks: ReadonlySet<string> | undefined;
	tree: FolderNode[] | undefined;
	looseNoteCount: number | undefined;
	/** Open the field for a new top-level notebook, as the header's `+` does. */
	onCreate: () => void;
}

/**
 * The list itself. Its own component because the sidebar around it is now a
 * header, a hint, three things that can be open at once and this — and all of
 * it in one function is a shape nobody can read.
 */
const TreeBody = ({
	tree,
	looseNoteCount,
	onCreate,
	selectedFolder,
	onSelectFolder,
	moving,
	over,
	onOver,
	onPickUp,
	onDrop,
	onCancelMove,
	renaming,
	onDraft,
	onRenamed,
	onMenu,
	itemsFor,
	openNotebooks = NONE_OPEN,
	onToggle,
	onDwell,
}: TreeBodyProps) => (
	// Room for a chevron before every name, so the names stand in one column,
	// only where some notebook has one.
	<ul className={tree?.some((node) => node.children.length > 0) ? 'tree nested' : 'tree'}>
		{/* With no notebooks and the loose notes not yet counted there is
			nothing here to say — but "nothing" reads as an empty sidebar
			beside a note list that says it is still loading. */}
		{(tree === undefined || (tree.length === 0 && looseNoteCount === undefined)) && (
			<li className="muted placeholder">Loading…</li>
		)}
		{tree?.length === 0 && looseNoteCount === 0 && (
			<li className="muted placeholder">
				No notebooks yet.{' '}
				<button type="button" className="link-button" onClick={onCreate}>
					Create one
				</button>{' '}
				to start.
			</li>
		)}
		{/* The only way to bring a nested notebook back out, and so it
			appears exactly when something can land there — which is never
			for a note, and not for a notebook already at the top. It is a
			second row for the same directory as "Loose notes" below, and
			deliberately not the same row: that one holds notes and this one
			is where notebooks live, which is the distinction the root has
			always had here. */}
		{moving !== null && canDrop(moving, ROOT) && (
			<li className="row-item">
				<Row
					path={ROOT}
					name={TOP_LEVEL_LABEL}
					landing="to the top level"
					selected={false}
					depth={0}
					moving={moving}
					over={over}
					onOver={onOver}
					onSelect={() => undefined}
					onDrop={onDrop}
					onCancelMove={onCancelMove}
				/>
			</li>
		)}
		{tree !== undefined && (
			<FolderRows
				nodes={tree}
				depth={0}
				selectedFolder={selectedFolder}
				onSelectFolder={onSelectFolder}
				moving={moving}
				over={over}
				onOver={onOver}
				onPickUp={onPickUp}
				onDrop={onDrop}
				onCancelMove={onCancelMove}
				renaming={renaming}
				onDraft={onDraft}
				onRenamed={onRenamed}
				onMenu={onMenu}
				itemsFor={itemsFor}
				openNotebooks={openNotebooks}
				onToggle={onToggle}
				onDwell={onDwell}
			/>
		)}
		{/* A row like the notebooks', the room for a `⋯` and all, so its count
		    lines up with theirs; it has none, since it is not a notebook and
		    cannot be renamed, moved or deleted. */}
		{looseNoteCount !== undefined && looseNoteCount > 0 && (
			<li className="row-item">
				<Row
					path={ROOT}
					name={LOOSE_NOTES_LABEL}
					selected={selectedFolder === ROOT}
					depth={0}
					count={looseNoteCount}
					moving={moving}
					over={over}
					onOver={onOver}
					onSelect={() => {
						onSelectFolder(ROOT);
					}}
					onDrop={onDrop}
					onCancelMove={onCancelMove}
				/>
			</li>
		)}
	</ul>
);

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
	renamings,
	openNotebooks,
	onOpenNotebooks,
	onPinFolder,
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
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [listing, setListing] = useState<string | null>(null);
	/** A notebook's row right-clicked, and where: its menu is open there. */
	const [menu, setMenu] = useState<{ path: string; at: MenuPoint } | null>(null);
	/** Which row the pointer is over, for the highlight and nothing else. */
	const [over, setOver] = useState<string | null>(null);

	useRevealed(selectedFolder, openNotebooks, onOpenNotebooks);
	const openThese = opener(onOpenNotebooks);
	const dwell = useDwell(openThese);

	const pickUp = onPickUp ?? (() => undefined);
	const drop = onDrop ?? (() => undefined);
	const cancel = onCancelMove ?? (() => undefined);

	/**
	 * The notebook the palette's commands are about. The root is selectable while
	 * it holds loose notes and is not a notebook: it cannot be renamed, moved or
	 * deleted, and a notebook made "inside" it is a top-level one anyway.
	 */
	const open =
		selectedFolder === undefined || selectedFolder === ROOT ? undefined : selectedFolder;
	const manageable = open !== undefined && moving === null;
	const going = deleting === null ? undefined : nodeAt(tree ?? [], deleting);

	/** Pinned or not, and the way to change it, where the route keeps pins. */
	const pinning = (
		path: string,
		node: FolderNode | undefined
	): Pick<NotebookActions, 'pinned' | 'onPin'> => {
		if (onPinFolder === undefined) return {};
		const pinned = node?.pinned === true;
		return {
			pinned,
			onPin: () => {
				onPinFolder(path, !pinned);
			},
		};
	};

	/**
	 * What the menu does to a notebook, from its row's `⋯` or a right-click on
	 * the row. One set of actions, so the two menus cannot drift.
	 */
	const actionsFor = (path: string): NotebookActions => {
		const node = nodeAt(tree ?? [], path);
		return {
			...pinning(path, node),
			onNewInside: () => {
				setCreating({ parent: path });
			},
			onRename: () => {
				setRenaming(path);
			},
			onMove: () => {
				pickUp({ kind: 'notebook', path, name: basename(path) });
			},
			onFiles:
				(node?.fileCount ?? 0) === 0
					? undefined
					: () => {
							setListing(path);
						},
			onDelete: () => {
				setDeleting(path);
			},
		};
	};

	const renamed = (path: string, chosen?: string) => {
		setRenaming(null);
		const trimmed = chosen?.trim();
		// Nothing typed, Escape, or the name it already had: all of them are the
		// user changing their mind, and none of them is worth a move on the
		// provider — `moveFolder` answers a rename to the same name with nothing
		// at all, but the queue and the toast are cheaper not to reach.
		if (
			trimmed === undefined ||
			trimmed === '' ||
			trimmed === basename(path) ||
			onRenameFolder === undefined
		) {
			renamings?.clear('notebook', path);
			return;
		}
		// Shown as given until the route has the notebook at its new path.
		renamings?.give('notebook', path, path);
		onRenameFolder(path, trimmed);
	};

	useCommand({
		id: 'notebook.rename',
		label: 'Rename notebook',
		group: 'Notebook',
		enabled: manageable,
		run: () => {
			setRenaming(open ?? null);
			// The row becomes the field, so it has to be listed: a notebook inside
			// a shut one is not, and its name would wait there for whenever that
			// one is opened next, and take the focus then.
			if (open !== undefined) openThese(...ancestorPaths(open));
			onReveal?.();
		},
	});

	useCommand({
		id: 'notebook.delete',
		label: 'Delete notebook',
		group: 'Notebook',
		enabled: manageable,
		run: () => {
			setDeleting(open ?? null);
			onReveal?.();
		},
	});

	return (
		<nav className="sidebar" aria-label="Notebooks">
			<div className="pane-header">
				<h2>Notebooks</h2>
				<div className="pane-actions">
					<button
						type="button"
						className="icon"
						// Unconditionally the top level. What the `+` in a pane
						// header makes is a notebook, and the top level is where
						// notebooks live; anywhere else is asked for by name.
						title="New notebook"
						aria-label="New notebook"
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
				<AttachedFiles
					name={basename(listing)}
					path={listing}
					onClose={() => {
						setListing(null);
					}}
				/>
			)}

			{deleting !== null && (
				<DeleteConfirm
					name={basename(deleting)}
					noteCount={going === undefined ? 0 : notesUnder(going)}
					fileCount={going === undefined ? 0 : filesUnder(going)}
					onConfirm={() => {
						setDeleting(null);
						onDeleteFolder?.(deleting);
					}}
					onCancel={() => {
						setDeleting(null);
					}}
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
				onDraft={(path, text) => {
					renamings?.typed('notebook', path, text);
				}}
				onRenamed={renamed}
				onMenu={(path, at) => {
					setMenu({ path, at });
				}}
				itemsFor={(path) => notebookMenuItems(basename(path), actionsFor(path))}
				openNotebooks={openNotebooks}
				onToggle={toggleWith(onOpenNotebooks)}
				onDwell={dwell}
			/>

			{menu !== null && (
				<FloatingMenu
					at={menu.at}
					label={`Notebook “${basename(menu.path)}”`}
					items={notebookMenuItems(basename(menu.path), actionsFor(menu.path))}
					onClose={() => {
						setMenu(null);
					}}
				/>
			)}

			{footer}
		</nav>
	);
};
