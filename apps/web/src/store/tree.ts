import { ancestorPaths, basename, parentPath, ROOT } from '@skysa/core';

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

	const childrenOf = (parent: string): FolderNode[] =>
		[...all]
			.filter((path) => parentPath(path) === parent)
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

/** Is `path` one of the folders in this tree? */
export const containsPath = (tree: readonly FolderNode[], path: string): boolean =>
	tree.some((node) => node.path === path || containsPath(node.children, path));

/** The folder at `path` in this tree, at any depth, if it is there. */
export const findFolder = (tree: readonly FolderNode[], path: string): FolderNode | undefined =>
	tree.reduce<FolderNode | undefined>(
		(found, node) => found ?? (node.path === path ? node : findFolder(node.children, path)),
		undefined
	);

/**
 * What the root of the app folder is called when it holds notes. A note there
 * belongs to no notebook, which is a shape the remote folder can hand us — the
 * app itself never creates one (docs/ARCHITECTURE.md §12.6).
 */
export const LOOSE_NOTES_LABEL = 'Loose notes';

/** What to call a folder in a pane heading. Only the root needs a name. */
export const folderLabel = (path: string): string => (path === ROOT ? LOOSE_NOTES_LABEL : path);

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
