import { ancestorPaths, basename, isScratchPath, parentPath, ROOT } from '@skysa/core';

import { t } from '../i18n/t.js';
import { pinnedFirst } from './pins.js';
import { SCRATCHPAD_LABEL } from './scratchpad.js';

/**
 * Flat folder paths in, a nested tree out. Kept pure and separate from the
 * components so the shape of the sidebar is testable without rendering anything.
 */
export interface FolderNode {
	path: string;
	/** Final segment, which is the name the user sees. */
	name: string;
	children: FolderNode[];
	/** Number of live notes directly inside this folder. */
	noteCount: number;
	/** Number of files that are not notes directly inside it (#187). */
	fileCount: number;
	/** Pinned to the top of its level on this device (`withPins`). */
	pinned?: boolean;
}

export interface BuildFolderTreeInput {
	paths: readonly string[];
	/** Path of every live note, used to count notes per folder. */
	notePaths?: readonly string[];
	/**
	 * Path of every file beside the notes, used to count them. Counted only: a
	 * file draws no notebook, since the app only ever puts one beside a note.
	 */
	filePaths?: readonly string[];
}

const countsByFolder = (paths: readonly string[]): Map<string, number> =>
	paths.reduce(
		(counts, path) => counts.set(parentPath(path), (counts.get(parentPath(path)) ?? 0) + 1),
		new Map<string, number>()
	);

/**
 * Builds the tree from folder rows, and also from any folder implied by a note's
 * path: a note can sit in a folder whose row has not arrived from sync yet, and
 * it should still appear somewhere rather than vanish.
 */
export const buildFolderTree = (input: BuildFolderTreeInput): FolderNode[] => {
	const notePaths = input.notePaths ?? [];
	const counts = countsByFolder(notePaths);
	const fileCounts = countsByFolder(input.filePaths ?? []);

	const seed = [...input.paths, ...notePaths.map(parentPath)].filter((path) => path !== ROOT);
	const all = new Set(seed.flatMap((path) => [...ancestorPaths(path), path]));
	// Each folder under its parent, once: asking every folder whether it is
	// in each one was a quarter of a million asks for five hundred notebooks,
	// on every autosave and every sync run.
	const under = [...all].reduce((byParent, path) => {
		const parent = parentPath(path);
		const siblings = byParent.get(parent);
		if (siblings === undefined) return byParent.set(parent, [path]);
		// eslint-disable-next-line functional/immutable-data
		siblings.push(path);
		return byParent;
	}, new Map<string, string[]>());

	const childrenOf = (parent: string): FolderNode[] =>
		[...(under.get(parent) ?? [])]
			.sort((a, b) => a.localeCompare(b))
			.map((path) => ({
				path,
				name: basename(path),
				children: childrenOf(path),
				noteCount: counts.get(path) ?? 0,
				fileCount: fileCounts.get(path) ?? 0,
			}));

	return childrenOf(ROOT);
};

/** Two nodes that say the same of their notebook, their own fields compared. */
const sameNode = (a: FolderNode, b: FolderNode): boolean =>
	a.path === b.path &&
	a.name === b.name &&
	a.noteCount === b.noteCount &&
	a.fileCount === b.fileCount &&
	a.pinned === b.pinned;

/**
 * `next`, with each notebook that has not changed since `before` — nor has
 * anything inside it — handed back as the node it was then, and the whole
 * tree as it was where nothing in it changed. The tree is built again on every
 * autosave and sync run, and a row, or the note list's order, that compares
 * what it is given by identity is then only redone for what changed.
 */
export const keptTree = (before: FolderNode[] | undefined, next: FolderNode[]): FolderNode[] => {
	if (before === undefined) return next;
	const was = new Map(before.map((node) => [node.path, node]));
	const kept = next.map((node) => {
		const old = was.get(node.path);
		const children = keptTree(old?.children, node.children);
		if (old !== undefined && sameNode(old, node) && children === old.children) return old;
		return children === node.children ? node : { ...node, children };
	});
	return kept.length === before.length && kept.every((node, at) => node === before[at])
		? before
		: kept;
};

/**
 * The tree with the pinned notebooks first at each level: a pinned notebook
 * goes to the top of the notebooks beside it, under its own parent, and the
 * rest keep their order (`store/pins.ts`).
 */
export const withPins = (tree: readonly FolderNode[], pinned: ReadonlySet<string>): FolderNode[] =>
	pinnedFirst(
		tree.map((node) => ({
			...node,
			pinned: pinned.has(node.path),
			children: withPins(node.children, pinned),
		})),
		(node) => node.pinned
	);

/** Is `path` one of the folders in this tree? */
export const containsPath = (tree: readonly FolderNode[], path: string): boolean =>
	tree.some((node) => node.path === path || containsPath(node.children, path));

/** The folder at `path` in this tree, at any depth, if it is there. */
export const findFolder = (tree: readonly FolderNode[], path: string): FolderNode | undefined =>
	tree.reduce<FolderNode | undefined>(
		(found, node) => found ?? (node.path === path ? node : findFolder(node.children, path)),
		undefined
	);

/** A notebook and every notebook inside it, at any depth, as the sidebar lists them. */
const inSidebarOrder = (node: FolderNode): string[] => [
	node.path,
	...node.children.flatMap(inSidebarOrder),
];

/**
 * The notes by the notebook each is in: the notebooks in the order their first
 * note came, and each one's notes in the order they came. Added to in place: a
 * copy of a notebook's notes for each note added to it is half a million
 * copies for a notebook of a thousand, on every draw of the list.
 */
export const byParent = <T extends Readonly<{ path: string }>>(
	notes: readonly T[]
): Map<string, T[]> =>
	notes.reduce((groups, note) => {
		const folder = parentPath(note.path);
		const group = groups.get(folder);
		if (group === undefined) return groups.set(folder, [note]);
		// eslint-disable-next-line functional/immutable-data
		group.push(note);
		return groups;
	}, new Map<string, T[]>());

/**
 * A notebook's list, from every note under it: its own notes first, then each
 * notebook's inside it, at any depth, together and in the order the sidebar
 * has the notebooks — the pinned first at each level (`withPins`), and each
 * notebook before the ones inside it. In each, the pinned notes first, and
 * otherwise the order the notes came in.
 *
 * The tree and the notes are separate queries, so a note can arrive in a
 * notebook the tree does not have yet — one just made by a move or a pull.
 * Its notes go after the rest, by the notebook's path, rather than nowhere.
 */
export const listedUnder = <T extends Readonly<{ path: string }>>(
	notes: readonly T[],
	folder: string,
	tree: readonly FolderNode[] | undefined,
	pinned: (note: T) => boolean
): T[] => {
	const node = tree === undefined ? undefined : findFolder(tree, folder);
	const known = node === undefined ? [folder] : inSidebarOrder(node);
	const byNotebook = byParent(notes);
	const inTree = new Set(known);
	const unknown = [...byNotebook.keys()]
		.filter((path) => !inTree.has(path))
		.sort((a, b) => a.localeCompare(b));
	return [...known, ...unknown].flatMap((path) =>
		pinnedFirst(byNotebook.get(path) ?? [], pinned)
	);
};

/**
 * What the root of the app folder is called when it holds notes. A note there
 * belongs to no notebook, which is a shape the remote folder can hand us — the
 * app itself never creates one (docs/ARCHITECTURE.md §12.6).
 */
export const LOOSE_NOTES_LABEL = t('notebooks.looseNotes');

/**
 * What to call a folder in a pane heading. Only the root needs a name, and the
 * scratchpad's folder, which is no notebook and is not called by its path.
 */
export const folderLabel = (path: string): string => {
	if (path === ROOT) return LOOSE_NOTES_LABEL;
	return isScratchPath(path) ? SCRATCHPAD_LABEL : path;
};

/**
 * Is `path` a folder that can be open? The root only while it holds loose
 * notes, and while they are still being counted, so that a user who asked for
 * it is kept there: if it does turn out to be empty the fallback happens once,
 * a moment later, rather than a notebook opening and the root snapping back
 * over it.
 */
const openable = (
	tree: readonly FolderNode[],
	path: string,
	looseNoteCount: number | undefined
): boolean =>
	// `containsPath` never finds the root, so it is answered first.
	path === ROOT ? looseNoteCount === undefined || looseNoteCount > 0 : containsPath(tree, path);

/**
 * Which notebook to open. The one asked for (the URL), else the one open last
 * on this device (`store/lastOpen.ts`), else the first. The root is not a
 * notebook, and it is only selectable at all while it holds loose notes, so a
 * request for a folder that is not there — a stale link, or a notebook deleted
 * underneath the user — falls back rather than to a pane the sidebar offers no
 * way out of.
 *
 * With both notebooks and loose notes present and nothing asked for or
 * remembered, the first notebook wins: loose notes are an exception to the
 * structure, not the place to start.
 *
 * `tree`, `looseNoteCount` and `remembered` arrive from separate live queries
 * that resolve in any order, so each carries `undefined` for "not known yet"
 * and none may be read as "there are none". Answering too early means opening
 * one folder and jumping to another a frame later, which reads as the app
 * losing the user's place. `remembered` is `null` when there is nothing
 * remembered, which is a real answer.
 *
 * While the tree is still loading, `requested` is returned unchanged for the
 * same reason. `undefined` means nothing is open: nothing asked for and none
 * to fall back to, or not known yet.
 */
export const selectedFolderPath = (
	tree: readonly FolderNode[] | undefined,
	requested: string | undefined,
	looseNoteCount: number | undefined,
	remembered: string | null | undefined
): string | undefined => {
	if (tree === undefined) return requested;
	if (requested !== undefined && openable(tree, requested, looseNoteCount)) return requested;

	if (remembered === undefined) return undefined;
	if (remembered !== null && openable(tree, remembered, looseNoteCount)) return remembered;
	if (tree[0] !== undefined) return tree[0].path;

	// No notebooks, so the root is the only thing there could be to open — but
	// only once we know it holds something. Until then nothing is open, and the
	// note list says it is still loading rather than that there is nothing here.
	return looseNoteCount !== undefined && looseNoteCount > 0 ? ROOT : undefined;
};
