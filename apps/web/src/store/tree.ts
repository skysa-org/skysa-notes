import { basename, parentPath, ROOT } from '@skysa/core';

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
}

/** Every ancestor of a path, outermost first, excluding the root. */
export const ancestorPaths = (path: string): string[] => {
	const parent = parentPath(path);
	return parent === ROOT ? [] : [...ancestorPaths(parent), parent];
};

export interface BuildFolderTreeInput {
	paths: readonly string[];
	/** Path of every live note, used to count notes per folder. */
	notePaths?: readonly string[];
}

const countsByFolder = (notePaths: readonly string[]): Map<string, number> =>
	notePaths.reduce(
		(counts, notePath) =>
			counts.set(parentPath(notePath), (counts.get(parentPath(notePath)) ?? 0) + 1),
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

	const seed = [...input.paths, ...notePaths.map(parentPath)].filter((path) => path !== ROOT);
	const all = new Set(seed.flatMap((path) => [...ancestorPaths(path), path]));

	const childrenOf = (parent: string): FolderNode[] =>
		[...all]
			.filter((path) => parentPath(path) === parent)
			.sort((a, b) => a.localeCompare(b))
			.map((path) => ({
				path,
				name: basename(path),
				children: childrenOf(path),
				noteCount: counts.get(path) ?? 0,
			}));

	return childrenOf(ROOT);
};

/** Is `path` one of the folders in this tree? */
export const containsPath = (tree: readonly FolderNode[], path: string): boolean =>
	tree.some((node) => node.path === path || containsPath(node.children, path));

/**
 * Which notebook to open. The root is not a notebook and is not listed, so a
 * request for a folder that no longer exists — a stale link, or a notebook
 * deleted underneath the user — falls back to the first notebook rather than
 * to a pane the sidebar offers no way out of.
 *
 * Returns `undefined` while the tree is still loading, and when there are no
 * notebooks at all.
 */
export const selectedFolderPath = (
	tree: readonly FolderNode[] | undefined,
	requested: string | undefined
): string | undefined => {
	if (tree === undefined) return requested;
	if (requested !== undefined && containsPath(tree, requested)) return requested;
	return tree[0]?.path;
};
