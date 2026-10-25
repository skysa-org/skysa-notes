import { MARKER_FILE } from '../config.js';
import { buildMarker, type MarkerCreatedBy, serializeMarker } from '../marker.js';
import { normalizePath, ROOT } from '../paths.js';
import type { FetchLike } from './http.js';
import { decodeText } from './text.js';
import { type EntryRef, isConflictError, NotFoundError, type RemoteEntry } from './types.js';

/**
 * What the HTTP adapters do the same way on the contract's side: the options
 * each is made with, the marker, reading a note as text, the root's guard and
 * entry, and telling an entry from another at its path.
 */

export interface HttpProviderOptions {
	fetch: FetchLike;
	/** Called per request, so a refreshed token is picked up without rebuilding. */
	getAccessToken: () => Promise<string>;
	appVersion: string;
	clientId: string;
	userAgent?: string;
}

/**
 * The marker, written only where there is none (docs/ARCHITECTURE.md §3).
 * `create` must refuse an occupied path with a `ConflictError`, so a marker
 * another device wrote between the look and the write stands, and this is a
 * no-op rather than an overwrite of its provenance.
 */
export const writeMarkerOnce = async (
	options: Pick<HttpProviderOptions, 'appVersion' | 'clientId' | 'userAgent'> & {
		provider: MarkerCreatedBy['provider'];
	},
	exists: () => Promise<boolean>,
	create: (path: string, content: string) => Promise<unknown>
): Promise<void> => {
	if (await exists()) return;
	const marker = buildMarker({
		appVersion: options.appVersion,
		provider: options.provider,
		clientId: options.clientId,
		...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
	});
	await create(MARKER_FILE, serializeMarker(marker)).catch((error: unknown) => {
		if (isConflictError(error)) return;
		throw error;
	});
};

/** `read` as the contract has it: `readBytes`, decoded as a note's UTF-8. */
export const readAsText =
	(readBytes: (entry: EntryRef) => Promise<{ bytes: Uint8Array; version: string }>) =>
	async (entry: EntryRef): Promise<{ content: string; version: string }> => {
		const { bytes, version } = await readBytes(entry);
		return { content: decodeText(bytes, entry.path), version };
	};

/**
 * `act` on the normalized path, unless it is the root, which no file can be
 * written at: a `NotFoundError`, as the rejection of the promise `act` would
 * have given.
 */
export const outsideRoot = <T>(path: string, act: (target: string) => Promise<T>): Promise<T> => {
	const target = normalizePath(path);
	return target === ROOT ? Promise.reject(new NotFoundError(target)) : act(target);
};

/** The app folder itself, as `createFolder('')` answers it: there already. */
export const rootFolderEntry = (remoteId: string): RemoteEntry => ({
	remoteId,
	path: ROOT,
	kind: 'folder',
	version: '',
	modifiedAt: '',
});

/**
 * Is what is at a path the very entry we were asked to act on?
 *
 * By id wherever both sides have one: that is what the request addressed the
 * entry by, and an `EntryRef`'s path is only as fresh as the caller's last
 * look. A note that has never been pushed carries no id, and then the path is
 * all there is to go on — compared as the provider compares names: `folded`
 * where it is case-insensitive (Dropbox, OneDrive), exactly where it is not
 * (Drive). Folded, because on a case-insensitive provider the path that comes
 * back carries the case the *user* typed, routinely spelled differently from
 * the one the caller holds for the very same file. Compared exactly, a move
 * that had already happened would be reported as a conflict, and the conflict
 * rule would write the user's note aside as a copy of itself.
 */
export const isSelf = (
	entry: EntryRef,
	current: RemoteEntry,
	paths: 'folded' | 'exact'
): boolean => {
	if (entry.remoteId !== '' && current.remoteId !== '')
		return entry.remoteId === current.remoteId;
	const asked = normalizePath(entry.path);
	return paths === 'folded'
		? asked.toLowerCase() === current.path.toLowerCase()
		: asked === current.path;
};
