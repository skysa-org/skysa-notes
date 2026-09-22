import { ROOT } from '@skysa/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { canDrop, type Moving } from '../store/rearrange.js';
import { type FolderNode, LOOSE_NOTES_LABEL } from '../store/tree.js';

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
 */

export interface SidebarProps {
	tree: FolderNode[] | undefined;
	/** Undefined until the tree has loaded, and when there are no notebooks. */
	selectedFolder: string | undefined;
	onSelectFolder: (path: string) => void;
	/** A new notebook goes inside the open one, or at the root when there is none. */
	onCreateFolder: (parentPath: string | undefined, name: string) => void;
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
}

/**
 * Inline rather than a `prompt()`: a modal browser dialog blocks the page, is
 * unstyleable, and behaves badly in an installed PWA.
 */
interface NewFolderFieldProps {
	onCancel: () => void;
	onSubmit: (name: string) => void;
}

const NewFolderField = ({ onCancel, onSubmit }: NewFolderFieldProps) => {
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
			aria-label="New notebook name"
			placeholder="Notebook name"
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
}: FolderRowsProps) => (
	<>
		{nodes.map((node) => (
			<li key={node.path}>
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
						/>
					</ul>
				)}
			</li>
		))}
	</>
);

/** The top level of the tree, which has no row of its own until one is needed. */
const TOP_LEVEL_LABEL = 'Top level';

export const Sidebar = ({
	tree,
	selectedFolder,
	onSelectFolder,
	onCreateFolder,
	looseNoteCount,
	footer,
	moving = null,
	onPickUp,
	onDrop,
	onCancelMove,
}: SidebarProps) => {
	const [creating, setCreating] = useState(false);
	/** Which row the pointer is over, for the highlight and nothing else. */
	const [over, setOver] = useState<string | null>(null);

	const pickUp = onPickUp ?? (() => undefined);
	const drop = onDrop ?? (() => undefined);
	const cancel = onCancelMove ?? (() => undefined);

	return (
		<nav className="sidebar" aria-label="Notebooks">
			<div className="pane-header">
				<h2>Notebooks</h2>
				<button
					type="button"
					className="icon"
					title="New notebook"
					aria-label="New notebook"
					// A move is a mode, and a notebook made in the middle of one
					// would land in a tree the user is holding a piece of.
					disabled={moving !== null}
					onClick={() => {
						setCreating(true);
					}}
				>
					+
				</button>
			</div>

			{moving !== null && <MoveHint moving={moving} />}

			{creating && (
				<NewFolderField
					onCancel={() => {
						setCreating(false);
					}}
					onSubmit={(name) => {
						setCreating(false);
						// The root is not a notebook, so a notebook created while
						// the loose notes are open goes alongside them, not inside.
						onCreateFolder(selectedFolder === ROOT ? undefined : selectedFolder, name);
					}}
				/>
			)}

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
							onOver={setOver}
							onSelect={() => undefined}
							onDrop={drop}
							onCancelMove={cancel}
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
						onOver={setOver}
						onPickUp={pickUp}
						onDrop={drop}
						onCancelMove={cancel}
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
							onOver={setOver}
							onSelect={() => {
								onSelectFolder(ROOT);
							}}
							onDrop={drop}
							onCancelMove={cancel}
						/>
					</li>
				)}
			</ul>

			{footer}
		</nav>
	);
};
