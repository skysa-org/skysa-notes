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
 * What the root of the app folder is called when it holds notes. A note there
 * belongs to no notebook, which is a shape the remote folder can hand us — the
 * app itself never creates one (docs/PLAN.md §12.6).
 */
export const LOOSE_NOTES_LABEL = 'Loose notes';

/** What to call a folder in a pane heading. Only the root needs a name. */
export const folderLabel = (path: string): string => (path === ROOT ? LOOSE_NOTES_LABEL : path);

/**
 * Which notebook to open. The root is not a notebook, and it is only selectable
 * at all while it holds loose notes, so a request for a folder that is not
 * there — a stale link, or a notebook deleted underneath the user — falls back
 * to the first notebook rather than to a pane the sidebar offers no way out of.
 *
 * With both notebooks and loose notes present and nothing asked for, the first
 * notebook wins: loose notes are an exception to the structure, not the place
 * to start.
 *
 * Both `tree` and `looseNoteCount` arrive from separate live queries that
 * resolve in either order, so both carry `undefined` for "not known yet" and
 * neither may be read as "there are none". Answering too early means opening
 * one folder and jumping to another a frame later, which reads as the app
 * losing the user's place.
 *
 * While the tree is still loading, `requested` is returned unchanged for the
 * same reason. `undefined` means nothing is open: no folder asked for and none
 * to fall back to.
 */
export const selectedFolderPath = (
	tree: readonly FolderNode[] | undefined,
	requested: string | undefined,
	looseNoteCount: number | undefined
): string | undefined => {
	if (tree === undefined) return requested;

	// `containsPath` never finds the root, so it is answered before the lookup.
	if (requested === ROOT) {
		// Still counting. Keep the user where they asked to be: if the root does
		// turn out to be empty the fallback below happens once, a moment later,
		// rather than a notebook opening and the root snapping back over it.
		if (looseNoteCount === undefined) return ROOT;
		return looseNoteCount > 0 ? ROOT : tree[0]?.path;
	}

	if (requested !== undefined && containsPath(tree, requested)) return requested;
	if (tree[0] !== undefined) return tree[0].path;

	// No notebooks, so the root is the only thing there could be to open — but
	// only once we know it holds something. Until then nothing is open, and the
	// note list says it is still loading rather than that there is nothing here.
	return looseNoteCount !== undefined && looseNoteCount > 0 ? ROOT : undefined;
};
