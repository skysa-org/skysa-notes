import { type ProviderKind } from '../config.js';

/**
 * The one interface the sync engine talks to. Every provider — Drive, Graph,
 * Dropbox, WebDAV — converts its own conventions to this at its edge, so the
 * engine never learns which one it is driving. See docs/PLAN.md §4.
 *
 * Paths here are always the normalized, POSIX, root-relative form from
 * `paths.ts`: no leading or trailing separator, and the root itself is `''`.
 */

export interface RemoteEntry {
	/** Provider file id; the path itself on path-based providers like WebDAV. */
	remoteId: string;
	path: string;
	kind: 'file' | 'folder';
	/**
	 * etag / rev / cTag / headRevisionId. Opaque: compare for equality only.
	 * Ordering means nothing — a "newer" version can sort lower.
	 */
	version: string;
	/** ISO 8601. */
	modifiedAt: string;
	/** UTF-8 bytes. Absent for folders. */
	size?: number;
}

/**
 * What `read`, `move` and `delete` actually need, which is all the local store
 * keeps: a note record carries `remoteId` and `path` and nothing else about the
 * remote entry. Taking the whole `RemoteEntry` would force every caller to
 * invent a `kind` and a `modifiedAt` it does not have, and would let an adapter
 * quietly depend on the invented value.
 *
 * `remoteId` is the identity for id-based providers; on WebDAV it *is* the
 * path, which is why renames there are re-linked through frontmatter `id`.
 */
export type EntryRef = Pick<RemoteEntry, 'remoteId' | 'path'>;

/**
 * A change that removed something. Deliberately not a `RemoteEntry` with a
 * flag: Dropbox's `DeletedMetadata` carries only a path — no id, no rev, no
 * timestamp — so anything richer would have adapters fabricating fields, and
 * the engine trusting them. Deletions are matched by path; `remoteId` is a
 * bonus from providers that do identify them.
 */
export interface DeletedEntry {
	path: string;
	deleted: true;
	remoteId?: string;
}

export type ChangeEntry = (RemoteEntry & { deleted?: false }) | DeletedEntry;

export interface ChangeSet {
	entries: readonly ChangeEntry[];
	/** Opaque; persisted per connection, and only after the batch commits. */
	cursor: string;
	more: boolean;
}

export interface WriteOptions {
	/**
	 * Omitting this means "create": a file already at that path is a
	 * `ConflictError`, never a silent overwrite. This is WebDAV's
	 * `If-None-Match: *`, and it is what makes re-creating a note that was
	 * deleted remotely safe — if the file came back in the meantime, the write
	 * conflicts instead of clobbering it.
	 */
	expectedVersion?: string;
}

/**
 * Written as property signatures rather than methods to match the house style
 * (`EntitlementProvider`), which `functional/prefer-property-signatures`
 * enforces.
 *
 * Semantics the signatures alone do not carry:
 * - `createFolder` and `delete` are idempotent, so a queued op is always safe
 *   to replay.
 * - `move` may or may not change `version` — Dropbox's `rev` survives a move,
 *   OneDrive's `eTag` does not — so the caller stores the returned entry rather
 *   than assuming either way.
 * - `list` is one level; `changes` covers the whole tree at every depth.
 * - Neither filters hidden paths: `.notesapp.json` has to reach the engine.
 *   Callers filter with `isHidden`.
 * - `rootId` is opaque, non-empty and stable. A provider whose root has no id
 *   of its own — a Dropbox app folder, where the root simply is `/` — returns a
 *   synthetic constant.
 * - Content is UTF-8 text. Binary attachments are out of scope (docs/PLAN.md §14).
 * - No `AbortSignal`: operations are short, and the engine discards results it
 *   no longer wants. Revisit in Phase 6 if a hung request ever blocks a queue.
 */
export interface StorageProvider {
	readonly kind: ProviderKind;
	/** Create the app folder if missing; write the marker only if absent. */
	readonly ensureRoot: () => Promise<{ rootId: string }>;
	readonly list: (folderPath: string) => Promise<RemoteEntry[]>;
	readonly read: (entry: EntryRef) => Promise<{ content: string; version: string }>;
	readonly write: (path: string, content: string, opts: WriteOptions) => Promise<RemoteEntry>;
	readonly createFolder: (path: string) => Promise<RemoteEntry>;
	readonly move: (entry: EntryRef, newPath: string) => Promise<RemoteEntry>;
	readonly delete: (entry: EntryRef) => Promise<void>;
	/** No cursor means a full scan of current state, which produces one. */
	readonly changes: (cursor?: string) => Promise<ChangeSet>;
}

/**
 * Errors carry a `code` as well as their class. `instanceof` is the ergonomic
 * check and works today, since `@skysa/core` resolves to one module per bundle;
 * the code is what keeps the guards below honest if core is ever published and
 * a consumer ends up with two copies of it either side of a sync boundary.
 */
export type ProviderErrorCode = 'conflict' | 'auth' | 'not-found' | 'cursor-reset';

/**
 * The remote moved under us. `remote` is the entry as it exists now, so the
 * conflict rule in docs/PLAN.md §7 can write the local copy aside without a
 * second round trip.
 */
export class ConflictError extends Error {
	// A class field rather than `this.name = ...` in the constructor: assigning
	// to `this` is banned, and the field satisfies `noImplicitOverride`.
	override readonly name = 'ConflictError';
	readonly code: ProviderErrorCode = 'conflict';

	constructor(readonly remote: RemoteEntry) {
		super(`conflict at ${remote.path}`);
	}
}

/** The engine responds by requesting a fresh access token from the backend. */
export class AuthError extends Error {
	override readonly name = 'AuthError';
	readonly code: ProviderErrorCode = 'auth';
}

/** The entry is gone, or `expectedVersion` was given for a path with no file. */
export class NotFoundError extends Error {
	override readonly name = 'NotFoundError';
	readonly code: ProviderErrorCode = 'not-found';

	constructor(readonly path: string) {
		super(`not found: ${path}`);
	}
}

/**
 * The cursor is no longer usable — Dropbox answers `reset`, Graph answers
 * `410 resyncRequired`, WebDAV invalidates its sync-token. Distinct from a
 * transient failure, because the answer is to discard the cursor and re-scan
 * rather than to retry the same call forever.
 */
export class CursorResetError extends Error {
	override readonly name = 'CursorResetError';
	readonly code: ProviderErrorCode = 'cursor-reset';
}

const hasCode = (error: unknown, code: ProviderErrorCode): boolean =>
	typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;

export const isConflictError = (error: unknown): error is ConflictError =>
	error instanceof ConflictError || hasCode(error, 'conflict');

export const isAuthError = (error: unknown): error is AuthError =>
	error instanceof AuthError || hasCode(error, 'auth');

export const isNotFoundError = (error: unknown): error is NotFoundError =>
	error instanceof NotFoundError || hasCode(error, 'not-found');

export const isCursorResetError = (error: unknown): error is CursorResetError =>
	error instanceof CursorResetError || hasCode(error, 'cursor-reset');
