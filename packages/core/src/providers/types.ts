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
 * the engine trusting them. A deletion is matched by `remoteId` when it has one
 * and by path when it has not.
 *
 * So one of the two is always there, and either may be missing. A feed that
 * names items by id can be asked about a file it never placed — another
 * device's push after this device's cursor, deleted before the next pull — and
 * has no path to give. Dropping that deletion would leave the note here for
 * ever, since the cursor moves on and nothing mentions the file again.
 */
export type DeletedEntry =
	| { path: string; deleted: true; remoteId?: string }
	| { path?: undefined; deleted: true; remoteId: string };

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
 * - `move` to the path the entry is already at succeeds and changes nothing.
 *   The engine renames on the push path when it finds a rename queued behind a
 *   write, which leaves the queued `move` naming a path the file has already
 *   reached; the queue is ordered and stops on a failed op, so an adapter that
 *   reported this as an error would strand everything behind it. Dropbox's
 *   `files/move_v2` refuses it — with which of `to/conflict`,
 *   `duplicated_or_nested_paths` and `cant_move_folder_into_itself` is not
 *   documented — so its adapter reads the refusal and asks what is actually at
 *   the path, rather than trusting the tag.
 * - `read` fails with `NotFoundError` when there is nothing there, `AuthError`
 *   when the token is the problem, and an untyped error for anything else. Never
 *   `ConflictError` — the engine uses a read as an existence probe and takes a
 *   `NotFoundError` for "gone" and everything else for "could not say", and a
 *   conflict arriving from one would be routed as a conflict on the write.
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
	/**
	 * Whether `list` reports everything a folder holds.
	 *
	 * False on Google Drive: `drive.file` shows the app only the files it made
	 * itself, so a file the user dropped into a notebook through drive.google.com
	 * is invisible here (docs/PLAN.md §5.1), and a listing that comes back empty
	 * is no evidence the folder is. The engine removes a folder on the strength
	 * of a listing (`rmdir`), and will not where this is false, because deleting
	 * a folder takes everything under it — seen or not.
	 *
	 * True on Dropbox and OneDrive, which give the app its own folder and
	 * everything in it.
	 */
	readonly listsEverything: boolean;
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
export type ProviderErrorCode = 'conflict' | 'auth' | 'not-found' | 'cursor-reset' | 'rate-limit';

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

/**
 * The provider asked us to slow down: Dropbox and Graph answer 429, Graph also
 * a 503 that says how long to wait (a 503 that doesn't is an outage, not a
 * rate limit), and Drive a 403 whose reason names the quota, or a body whose
 * status is `RESOURCE_EXHAUSTED`. Distinct from a transient
 * failure because it says nothing at all about the request — so the engine does
 * not count it against the op's attempts — and because the provider often says
 * how long to wait, which is better than any backoff we could guess.
 *
 * `retryAfterMs` is absent when the provider said nothing, or said something
 * unreadable. The caller then uses its own backoff.
 */
export class RateLimitError extends Error {
	override readonly name = 'RateLimitError';
	readonly code: ProviderErrorCode = 'rate-limit';

	constructor(
		message: string,
		readonly retryAfterMs?: number
	) {
		super(message);
	}
}

/**
 * `Retry-After` is either a count of seconds or an HTTP date — both are legal
 * (RFC 9110 §10.2.3), Graph documents seconds and sends a date through some
 * fronts, and Dropbox puts the seconds in its JSON body instead.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After
 *
 * Answers `undefined` for anything it cannot read, so an unparseable value
 * falls back to the caller's backoff rather than to zero, which would hammer a
 * provider that has just asked for room. A date in the past is no wait at all.
 */
export const parseRetryAfter = (
	value: string | null | undefined,
	now: number = Date.now()
): number | undefined => {
	if (value === null || value === undefined) return undefined;
	// Read as a number only where it looks like one, and as a date only
	// otherwise. `Date.parse` is lenient enough to make a day in the first
	// century out of "7,30" or ", 120", and an unreadable value must answer
	// `undefined` rather than a wait of nothing, which would hammer a provider
	// that has just asked for room. A finite number, too: enough digits and
	// `Number` says `Infinity`.
	const one = (text: string): number | undefined => {
		if (/^-?\d+(?:\.\d+)?$/.test(text)) {
			const seconds = Number(text);
			return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined;
		}
		// Every legal date form carries a month or day name, and the ISO-8601
		// one a `T` and a `Z`. Without a letter it is not a date, whatever
		// `Date.parse` makes of it — ".5" is otherwise a day in the first
		// century, which clamps to a wait of nothing.
		if (!/[a-z]/i.test(text)) return undefined;
		const at = Date.parse(text);
		return Number.isNaN(at) ? undefined : Math.max(0, at - now);
	};
	// `Headers.get` joins a header sent twice with ", ", which is what an
	// intermediary adding its own `Retry-After` beside the provider's produces.
	// Which part is one value depends on the form, since an HTTP date carries a
	// comma of its own after the day name: a value starting with a digit is a
	// list of counts of seconds, and anything else is a date, whose first two
	// parts are one value. Of two counts the *longer* is taken — they are two
	// parties' answers to the same question, and coming back too early gets us
	// refused again, where coming back late costs only the wait.
	const parts = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
	const [head] = parts;
	if (head === undefined) return undefined;
	if (!/^-?\d/.test(head)) return one(parts.slice(0, 2).join(', '));
	const waits = parts.flatMap((part) => {
		const wait = one(part);
		return wait === undefined ? [] : [wait];
	});
	// `reduce`, not `Math.max(...waits)`: the parts come off a header, and
	// spreading an array of unknown length is a stack the caller does not control.
	return waits.length === 0 ? undefined : waits.reduce((a, b) => Math.max(a, b));
};

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

export const isRateLimitError = (error: unknown): error is RateLimitError =>
	error instanceof RateLimitError || hasCode(error, 'rate-limit');
