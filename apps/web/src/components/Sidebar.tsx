import { basename, ROOT } from '@skysa/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useCommand } from '../commands/context.js';
import { canDrop, type Moving } from '../store/rearrange.js';
import { type FolderNode, LOOSE_NOTES_LABEL } from '../store/tree.js';
import { NotebookMenu } from './NotebookMenu.js';
import { useEscape } from './useEscape.js';

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
 * are in the palette like everything else — docs/PLAN.md §7, "Commands are
 * declared, not collected") and putting down is a click on the destination row.
 * That is the same mode a drag enters, so there is one implementation and not
 * two: `moving` is set by the command or by `dragstart`, and read here and by
 * every row below without either of them knowing which it was.
 */
const MoveHint = ({ moving }: { moving: Moving }) => (
	<p className="move-hint" role="status">
		{`Moving “${moving.name}”. Choose where to put it, or press Escape.`}
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

/**
 * A notebook's name, being typed. The same shape the source tabs use: the field
 * takes the row's own box rather than appearing in one of its own, so the name
 * does not move when it becomes editable.
 */
const RenameRow = ({
	name,
	depth,
	onDone,
}: {
	name: string;
	depth: number;
	/** The chosen name, or nothing at all when the rename was abandoned. */
	onDone: (chosen?: string) => void;
}) => {
	const [draft, setDraft] = useState(name);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);

	useEffect(() => {
		// Focus first, and not `select()` alone: `select()` focuses as a side
		// effect in a browser and does not everywhere, which leaves a field that
		// looks ready and swallows the first thing typed into it.
		field.current?.focus();
		field.current?.select();
	}, []);

	// Once. Escape blurs the field, and a blur handler that had not been told
	// the rename was abandoned would put the typed name back in.
	const finish = (chosen?: string) => {
		if (done.current) return;
		done.current = true;
		onDone(chosen);
	};

	return (
		<span
			className="row-editing"
			style={{ paddingInlineStart: `${String(0.75 + depth * 0.85)}rem` }}
		>
			<input
				ref={field}
				className="row-rename"
				aria-label={`Rename ${name}`}
				value={draft}
				onChange={(event) => {
					setDraft(event.target.value);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						finish(draft);
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						finish();
					}
				}}
				onBlur={() => {
					finish(draft);
				}}
			/>
		</span>
	);
};

/**
 * Asked before a notebook goes, and not told afterwards — the rule the
 * disconnect confirm exists for (docs/PLAN.md §10), and the reason a notebook
 * needs one where a note does not: a note comes back from the notice that
 * follows it, and a notebook takes every note beneath it with it. So the count
 * is in the question, because that is the part the user may not know.
 *
 * A group of buttons and not a dialog: it is one question with two answers and
 * nothing behind it to trap focus against. Cancel holds the focus, as it does
 * everywhere else the app asks something it cannot undo.
 */
const DeleteConfirm = ({
	name,
	noteCount,
	onConfirm,
	onCancel,
}: {
	name: string;
	noteCount: number;
	onConfirm: () => void;
	onCancel: () => void;
}) => {
	const frame = useRef<HTMLDivElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);

	useEscape(frame, true, onCancel);

	useEffect(() => {
		cancel.current?.focus();
	}, []);

	return (
		<div ref={frame} className="confirm" role="group" aria-label="Delete notebook">
			<p>
				{noteCount === 0
					? `Delete \u201c${name}\u201d?`
					: `Delete \u201c${name}\u201d and the ${String(noteCount)} ${
							noteCount === 1 ? 'note' : 'notes'
						} in it?`}
			</p>
			<div className="confirm-answers">
				<button type="button" className="danger" onClick={onConfirm}>
					Delete
				</button>
				<button type="button" ref={cancel} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
};

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
}: RowProps) => {
	const allowed = moving !== null && canDrop(moving, path);
	const classes = [
		'row',
		selected && moving === null ? 'selected' : undefined,
		moving?.kind === 'notebook' && moving.path === path ? 'moving' : undefined,
		allowed && over === path ? 'drop-over' : undefined,
	].filter((each) => each !== undefined);

	return (
		<button
			type="button"
			className={classes.join(' ')}
			style={{ paddingInlineStart: `${String(0.75 + depth * 0.85)}rem` }}
			// A row nothing can land on is not a destination, and saying so with
			// `disabled` also takes it out of the tab order for the length of the
			// move — a keyboard user stepping through destinations should not have
			// to step over the one they are holding.
			disabled={moving !== null && !allowed}
			aria-label={
				moving === null ? undefined : destinationLabel(moving, name, landing, allowed)
			}
			aria-current={selected && moving === null ? 'true' : undefined}
			draggable={onPickUp !== undefined}
			onClick={() => {
				if (moving === null) onSelect();
				else onDrop(path);
			}}
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
		</button>
	);
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
	onRenamed: (path: string, chosen?: string) => void;
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
	onRenamed,
}: FolderRowsProps) => (
	<>
		{nodes.map((node) => (
			<li key={node.path}>
				{node.path === renaming ? (
					<RenameRow
						name={node.name}
						depth={depth}
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
						count={node.noteCount}
						moving={moving}
						over={over}
						onOver={onOver}
						onSelect={() => {
							onSelectFolder(node.path);
						}}
						onDrop={onDrop}
						onPickUp={() => {
							onPickUp({ kind: 'notebook', path: node.path, name: node.name });
						}}
						onCancelMove={onCancelMove}
					/>
				)}
				{node.children.length > 0 && (
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
							onRenamed={onRenamed}
						/>
					</ul>
				)}
			</li>
		))}
	</>
);

/** The top level of the tree, which has no row of its own until one is needed. */
const TOP_LEVEL_LABEL = 'Top level';

/** Every live note beneath a notebook, which is what deleting it would take. */
const notesUnder = (node: FolderNode): number =>
	node.children.reduce((total, child) => total + notesUnder(child), node.noteCount);

const nodeAt = (nodes: readonly FolderNode[], path: string): FolderNode | undefined =>
	nodes.reduce<FolderNode | undefined>(
		(found, node) => found ?? (node.path === path ? node : nodeAt(node.children, path)),
		undefined
	);

interface TreeBodyProps extends Omit<FolderRowsProps, 'nodes' | 'depth'> {
	tree: FolderNode[] | undefined;
	looseNoteCount: number | undefined;
}

/**
 * The list itself. Its own component because the sidebar around it is now a
 * header, a hint, three things that can be open at once and this — and all of
 * it in one function is a shape nobody can read.
 */
const TreeBody = ({
	tree,
	looseNoteCount,
	selectedFolder,
	onSelectFolder,
	moving,
	over,
	onOver,
	onPickUp,
	onDrop,
	onCancelMove,
	renaming,
	onRenamed,
}: TreeBodyProps) => (
	<ul className="tree">
		{/* With no notebooks and the loose notes not yet counted there is
			nothing here to say — but "nothing" reads as an empty sidebar
			beside a note list that says it is still loading. */}
		{(tree === undefined || (tree.length === 0 && looseNoteCount === undefined)) && (
			<li className="muted placeholder">Loading…</li>
		)}
		{tree?.length === 0 && looseNoteCount === 0 && (
			<li className="muted placeholder">No notebooks yet. Create one to start.</li>
		)}
		{/* The only way to bring a nested notebook back out, and so it
			appears exactly when something can land there — which is never
			for a note, and not for a notebook already at the top. It is a
			second row for the same directory as "Loose notes" below, and
			deliberately not the same row: that one holds notes and this one
			is where notebooks live, which is the distinction the root has
			always had here. */}
		{moving !== null && canDrop(moving, ROOT) && (
			<li>
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
				onRenamed={onRenamed}
			/>
		)}
		{looseNoteCount !== undefined && looseNoteCount > 0 && (
			<li>
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
}: SidebarProps) => {
	/** Where a notebook is being made, or null. `undefined` is the top level. */
	const [creating, setCreating] = useState<{ parent: string | undefined } | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	/** Which row the pointer is over, for the highlight and nothing else. */
	const [over, setOver] = useState<string | null>(null);

	const pickUp = onPickUp ?? (() => undefined);
	const drop = onDrop ?? (() => undefined);
	const cancel = onCancelMove ?? (() => undefined);

	/**
	 * The notebook everything in the menu is about. The root is selectable while
	 * it holds loose notes and is not a notebook: it cannot be renamed, moved or
	 * deleted, and a notebook made "inside" it is a top-level one anyway.
	 */
	const open =
		selectedFolder === undefined || selectedFolder === ROOT ? undefined : selectedFolder;
	const manageable = open !== undefined && moving === null;
	const openName = open === undefined ? '' : basename(open);
	const going = deleting === null ? undefined : nodeAt(tree ?? [], deleting);

	const renamed = (path: string, chosen?: string) => {
		setRenaming(null);
		const trimmed = chosen?.trim();
		// Nothing typed, Escape, or the name it already had: all of them are the
		// user changing their mind, and none of them is worth a move on the
		// provider — `moveFolder` answers a rename to the same name with nothing
		// at all, but the queue and the toast are cheaper not to reach.
		if (trimmed === undefined || trimmed === '' || trimmed === basename(path)) return;
		onRenameFolder?.(path, trimmed);
	};

	useCommand({
		id: 'notebook.rename',
		label: 'Rename notebook',
		group: 'Notebook',
		enabled: manageable,
		run: () => {
			setRenaming(open ?? null);
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
					<NotebookMenu
						name={openName}
						disabled={!manageable}
						onNewInside={() => {
							setCreating({ parent: open });
						}}
						onRename={() => {
							setRenaming(open ?? null);
						}}
						onMove={() => {
							if (open !== undefined) {
								pickUp({ kind: 'notebook', path: open, name: openName });
							}
						}}
						onDelete={() => {
							setDeleting(open ?? null);
						}}
					/>
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

			{moving !== null && <MoveHint moving={moving} />}

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

			{deleting !== null && (
				<DeleteConfirm
					name={basename(deleting)}
					noteCount={going === undefined ? 0 : notesUnder(going)}
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
				selectedFolder={selectedFolder}
				onSelectFolder={onSelectFolder}
				moving={moving}
				over={over}
				onOver={setOver}
				onPickUp={pickUp}
				onDrop={drop}
				onCancelMove={cancel}
				renaming={renaming}
				onRenamed={renamed}
			/>

			{footer}
		</nav>
	);
};
