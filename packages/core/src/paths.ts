import { HIDDEN_PREFIX, SCRATCHPAD_FOLDER } from './config.js';

/**
 * Paths are POSIX, relative to the app-owned root folder, and never begin or end
 * with a separator. The root itself is the empty string. Every provider adapter
 * converts to and from its own convention at its edge, so nothing above this
 * line has to care whether a provider is id-based or path-based.
 */

export const SEPARATOR = '/';

/** Root of the app folder. */
export const ROOT = '';

/**
 * A path with no empty, `.` or `..` segment, which is nearly every path the app
 * handles, and which `normalizePath` returns as it is. The sync engine asks
 * `isWithin` of the same few paths for every note in a round, and splitting them
 * each time was most of what a round of thousands of changes cost.
 */
const ALREADY_NORMAL = /^(?!\.\.?(?:\/|$))[^/]+(?:\/(?!\.\.?(?:\/|$))[^/]+)*$|^$/;

/**
 * Collapse repeated separators, drop `.` segments, resolve `..`, and trim the
 * ends. A `..` that would escape the root is dropped rather than honored: no
 * path this app produces may point outside the folder it owns.
 */
export const normalizePath = (path: string): string =>
	ALREADY_NORMAL.test(path)
		? path
		: path
				.split(SEPARATOR)
				.filter((segment) => segment !== '' && segment !== '.')
				.reduce<string[]>(
					(segments, segment) =>
						segment === '..' ? segments.slice(0, -1) : [...segments, segment],
					[]
				)
				.join(SEPARATOR);

export const joinPath = (...parts: readonly string[]): string =>
	normalizePath(parts.join(SEPARATOR));

/** Segments of a path, root being an empty list. */
export const pathSegments = (path: string): string[] => {
	const normalized = normalizePath(path);
	return normalized === ROOT ? [] : normalized.split(SEPARATOR);
};

/** The containing folder, or the root for a top-level entry. */
export const parentPath = (path: string): string => pathSegments(path).slice(0, -1).join(SEPARATOR);

/** The final segment: a filename, or a folder's own name. */
export const basename = (path: string): string => pathSegments(path).at(-1) ?? ROOT;

/** Every folder above a path, outermost first, excluding the root. */
export const ancestorPaths = (path: string): string[] => {
	const parent = parentPath(path);
	return parent === ROOT ? [] : [...ancestorPaths(parent), parent];
};

/** Replace the final segment, keeping the same parent. */
export const replaceBasename = (path: string, name: string): string =>
	joinPath(parentPath(path), name);

/**
 * Anything under a dot-prefixed segment is invisible to the UI and passed over
 * by sync, which is how the marker file, the clipboard and any provider
 * bookkeeping stay out of the way.
 *
 * Except the scratchpad's folder at the root: what is in it is notes, synced as
 * any are, which the scratchpad shows and the notebooks do not
 * (`isScratchPath`). Its dot keeps it out of other tools' lists of folders. A
 * dot-prefixed name inside it is hidden as anywhere else.
 */
export const isHidden = (path: string): boolean =>
	pathSegments(path).some(
		(segment, at) =>
			segment.startsWith(HIDDEN_PREFIX) && !(at === 0 && segment === SCRATCHPAD_FOLDER)
	);

/** True when `path` is `folder` itself or sits anywhere beneath it. */
export const isWithin = (path: string, folder: string): boolean => {
	const target = normalizePath(path);
	const base = normalizePath(folder);
	if (base === ROOT) return true;
	return target === base || target.startsWith(`${base}${SEPARATOR}`);
};

/**
 * The scratchpad's folder, or anything in it: a scratch note, a file beside
 * one. Never a notebook, a notebook's note or anything the tree counts.
 */
export const isScratchPath = (path: string): boolean => isWithin(path, SCRATCHPAD_FOLDER);

/**
 * Rewrite a path that sits under `from` so it sits under `to` instead. Used when
 * a folder is renamed or moved: every note inside it keeps its name and its
 * position relative to the folder.
 */
export const rebasePath = (path: string, from: string, to: string): string => {
	if (!isWithin(path, from)) return normalizePath(path);
	const suffix = normalizePath(path).slice(normalizePath(from).length);
	return normalizePath(`${normalizePath(to)}${suffix}`);
};
