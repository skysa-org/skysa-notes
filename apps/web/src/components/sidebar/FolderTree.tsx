import { ROOT } from '@skysa/core';
import {
	type CSSProperties,
	type KeyboardEvent,
	memo,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
} from 'react';

import { Icon } from '../../editor/icons.js';
import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import type { NotebookPin } from '../../store/pins.js';
import { canDrop, type Moving } from '../../store/rearrange.js';
import { type FolderNode, LOOSE_NOTES_LABEL, notesUnder } from '../../store/tree.js';
import { type MenuPoint, menuPoint, type OptionsMenuItem } from '../OptionsMenu.js';
import { RowOptions } from '../RowOptions.js';
import { rowIndent, RowRename } from '../RowRename.js';

/**
 * The notebook tree's rows: each notebook's, with its disclosure and its `⋯`,
 * the top level's and the loose notes', and the keys that move between them
 * (`TreeBody`). What the tree is, and why a notebook lists what is inside it
 * only while it is open, is said on the sidebar that holds it (`Sidebar.tsx`),
 * which also keeps the state these rows are handed.
 */

/**
 * A row's label while a move is on. Said outright rather than left to be read
 * off the row, which by then says the wrong thing: "Work" is where the user
 * would go, and during a move it is where the thing they are holding lands.
 */
const destinationLabel = (
	moving: Moving,
	name: string,
	landing: ((moving: Moving) => string) | undefined,
	allowed: boolean
): string =>
	allowed
		? (landing?.(moving) ?? t('notebooks.move.into', { name: moving.name, notebook: name }))
		: t('notebooks.move.cannotGo', { notebook: name });

interface RowProps {
	/** `ROOT` for the top level and for the loose notes. */
	path: string;
	name: string;
	/**
	 * Putting the thing here, in words, when "into <name>" is not how to say it.
	 * The top level is a place rather than a notebook: things go *to* it.
	 */
	landing?: (moving: Moving) => string;
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
	/** Pinned to the top or the bottom of its level on this device (`store/pins.ts`). */
	pinned?: NotebookPin | undefined;
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
	pinned,
}: RowProps) => {
	const pinId = useId();
	const allowed = moving !== null && canDrop(moving, path);
	const classes = [
		'row',
		pinned === 'top' ? 'pinned' : undefined,
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
			// found by, and in words as well as the tint (`.row.pinned`) or the
			// rule above the bottom's (`.pinned-bottom-rule`).
			aria-describedby={pinned === undefined ? undefined : pinId}
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
			{pinned !== undefined && (
				<span id={pinId} hidden>
					{pinned === 'top' ? t('rows.pinned') : t('rows.pinnedBottom')}
				</span>
			)}
		</button>
	);
};

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
			aria-label={t('notebooks.inside', { name })}
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

/**
 * `path` is the notebook at `at`, or one inside it at any depth: `isWithin`,
 * without its tidying of paths the tree's already are, as it is asked twice
 * for every row on every draw of the sidebar.
 */
const within = (path: string | null | undefined, at: string): boolean =>
	path !== null && path !== undefined && (path === at || path.startsWith(`${at}/`));

/** No notebook open, which is how every one starts. */
const NONE_OPEN: ReadonlySet<string> = new Set();

/**
 * The notebooks at one level, each a row of its own that is drawn again only
 * when something about it changes (`FolderItem`).
 */
const FolderRows = ({ nodes, ...rest }: FolderRowsProps) => (
	<>
		{nodes.map((node, at) => (
			<FolderItem
				key={node.path}
				node={node}
				ruled={node.pinned === 'bottom' && at > 0 && nodes[at - 1]?.pinned !== 'bottom'}
				{...rest}
				// Each row is told of the notebook selected, the one under the
				// pointer and the one being renamed only where it is the row or
				// one inside it: a new selection, or a drag from one row to the
				// next, then redraws the rows above the two it was and is, and
				// not the hundreds beside them.
				selectedFolder={
					within(rest.selectedFolder, node.path) ? rest.selectedFolder : undefined
				}
				over={within(rest.over, node.path) ? rest.over : null}
				renaming={within(rest.renaming, node.path) ? rest.renaming : null}
				// Only an open row draws rows inside it, and needs to know which
				// of those are open: a notebook opened or shut then redraws every
				// open row, and no shut one.
				openNotebooks={
					node.children.length > 0 && rest.openNotebooks.has(node.path)
						? rest.openNotebooks
						: NONE_OPEN
				}
			/>
		))}
	</>
);

/**
 * Every live note beneath a notebook, at any depth, kept by node: a node is
 * the same object until something under it changes (`keptTree`), and the
 * count is asked for on every draw of its row.
 */
const beneath = new WeakMap<FolderNode, number>();
const countBeneath = (node: FolderNode): number => {
	const known = beneath.get(node);
	if (known !== undefined) return known;
	const count = notesUnder(node);
	beneath.set(node, count);
	return count;
};

type FolderItemProps = Omit<FolderRowsProps, 'nodes'> & {
	node: FolderNode;
	/**
	 * The first of those pinned to the bottom, under the rest: a rule above it,
	 * from where the names at its level start, is what sets them apart.
	 */
	ruled: boolean;
};

const ruleStyle = (depth: number): CSSProperties & Record<`--${string}`, string> => ({
	'--rule-start': rowIndent(depth),
});

/** One notebook's row, and the rows of the notebooks inside it when it is open. */
const FolderItemView = ({
	node,
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
	ruled,
}: FolderItemProps) => {
	const hasChildren = node.children.length > 0;
	const open = hasChildren && openNotebooks.has(node.path);
	const toggle = (to: boolean) => {
		onToggle(node.path, to);
	};
	// What it holds at every depth, open or shut, which is what its
	// list shows: opening it does not change what is in it.
	const count = countBeneath(node);
	return (
		<li
			className={ruled ? 'pinned-bottom-rule' : undefined}
			style={ruled ? ruleStyle(depth) : undefined}
		>
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
						pinned={node.pinned}
					/>
				)}
				{/* Not while its name is being typed, when the row is a field;
				    nor while something is being moved, when the rows are only
				    places to put it. */}
				{node.path !== renaming && (
					<RowOptions
						name={node.name}
						kind="Notebook"
						items={() => itemsFor(node.path)}
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
};

const FolderItem = memo(FolderItemView);

/** The top level of the tree, which has no row of its own until one is needed. */
const TOP_LEVEL_LABEL = t('notebooks.topLevel');

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
export const TreeBody = ({
	tree,
	looseNoteCount,
	onCreate,
	selectedFolder,
	moving,
	over,
	renaming,
	openNotebooks = NONE_OPEN,
	...given
}: TreeBodyProps) => {
	// The sidebar's handlers are made again on each of its draws. The rows are
	// handed ones that stay the same and call those given last, so a row is
	// drawn again only when what it shows changes (`FolderItem`); set before the
	// browser paints, so an event never reaches the ones before.
	const latest = useRef(given);
	useLayoutEffect(() => {
		latest.current = given;
	});
	const onSelectFolder = useCallback((path: string) => {
		latest.current.onSelectFolder(path);
	}, []);
	const onOver = useCallback((path: string | null) => {
		latest.current.onOver(path);
	}, []);
	const onPickUp = useCallback((moving: Moving) => {
		latest.current.onPickUp(moving);
	}, []);
	const onDrop = useCallback((into: string) => {
		latest.current.onDrop(into);
	}, []);
	const onCancelMove = useCallback(() => {
		latest.current.onCancelMove();
	}, []);
	const onDraft = useCallback((path: string, text: string) => {
		latest.current.onDraft(path, text);
	}, []);
	const onRenamed = useCallback((path: string, chosen?: string) => {
		latest.current.onRenamed(path, chosen);
	}, []);
	const onMenu = useCallback((path: string, at: MenuPoint) => {
		latest.current.onMenu(path, at);
	}, []);
	const itemsFor = useCallback((path: string) => latest.current.itemsFor(path), []);
	const onToggle = useCallback((path: string, open: boolean) => {
		latest.current.onToggle(path, open);
	}, []);
	const onDwell = useCallback((path: string) => {
		latest.current.onDwell(path);
	}, []);
	return (
		// Room for a chevron before every name, so the names stand in one column,
		// only where some notebook has one.
		<ul className={tree?.some((node) => node.children.length > 0) ? 'tree nested' : 'tree'}>
			{/* With no notebooks and the loose notes not yet counted there is
			nothing here to say — but "nothing" reads as an empty sidebar
			beside a note list that says it is still loading. */}
			{(tree === undefined || (tree.length === 0 && looseNoteCount === undefined)) && (
				<li className="muted placeholder">{t('notebooks.loading')}</li>
			)}
			{tree?.length === 0 && looseNoteCount === 0 && (
				<li className="muted placeholder">
					{rich('notebooks.empty', {
						create: (words) => (
							<button type="button" className="link-button" onClick={onCreate}>
								{words}
							</button>
						),
					})}
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
						landing={(held) => t('notebooks.move.toTopLevel', { name: held.name })}
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
};
