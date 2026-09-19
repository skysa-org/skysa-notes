import { MARKER_FILE, type ProviderKind } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { isWithin, normalizePath, parentPath, rebasePath, ROOT } from '../paths.js';
import { decodeText } from './text.js';
import {
	type ChangeEntry,
	type ChangeSet,
	ConflictError,
	CursorResetError,
	type EntryRef,
	NotFoundError,
	type RemoteEntry,
	type StorageProvider,
	type WriteOptions,
} from './types.js';

/**
 * An in-memory `StorageProvider`. It is what the contract suite runs against in
 * CI, and what every sync-engine test drives, so it is deliberately the
 * strictest provider in the repo: where docs/PLAN.md §4 leaves a case open, the
 * fake takes the least forgiving reading. A lenient fake would let the engine
 * grow assumptions that only fail against a real account.
 *
 * Specifically it never blind-overwrites, never creates a missing parent, hands
 * out a fresh `version` on every single write even when the bytes are
 * identical, and compares versions for equality rather than order.
 *
 * Written as closures over `Map`s: `functional/no-let` rules out mutable
 * bindings, and one-entry maps stand in for the scalars — the same shape
 * `apps/api/src/worker.ts` uses for its isolate cache.
 */

interface FakeNode {
	remoteId: string;
	path: string;
	kind: 'file' | 'folder';
	version: string;
	modifiedAt: string;
	/** Empty for folders, and for a file held as `bytes`. */
	content: string;
	/**
	 * A file some other tool wrote, as the bytes it wrote (`writeBytes`). Kept
	 * apart from `content` because they need not be text at all, and a test of
	 * what the engine does with such a file has to be able to show that they
	 * are the same bytes afterwards.
	 */
	bytes?: Uint8Array | undefined;
}

export type FakeOperation =
	'ensureRoot' | 'list' | 'read' | 'write' | 'createFolder' | 'move' | 'delete' | 'changes';

export interface FakeCall {
	op: FakeOperation;
	path?: string;
	/** 1-based count of calls to this operation, so a test can fail only the second. */
	attempt: number;
}

/** Return an error to make the call fail, or `undefined` to let it through. */
export type FakeFault = (call: FakeCall) => Error | undefined;

export interface FakeProviderOptions {
	/** Which provider this stands in for. Not part of `PROVIDER_KINDS`' business. */
	kind?: ProviderKind;
	appVersion?: string;
	clientId?: string;
	userAgent?: string;
	/** Base for the deterministic clock. */
	startAt?: Date;
	/** How far `modifiedAt` advances per mutation. */
	tickMs?: number;
	/**
	 * Entries per `changes()` page. The default returns everything at once;
	 * setting it small is how the engine's drain loop gets exercised.
	 */
	pageSize?: number;
	/**
	 * Whether moving or deleting a folder reports its descendants too. Drive
	 * reports only the folder and leaves the caller to rebase; Dropbox and Graph
	 * report every affected entry. One knob, both behaviours.
	 */
	folderChanges?: 'folder-only' | 'recursive';
	/**
	 * Whether a listing is the whole truth about a folder. Set false to stand in
	 * for Drive, whose scope hides what the user put there (`StorageProvider`).
	 */
	listsEverything?: boolean;
}

export interface FakeProvider extends StorageProvider {
	readonly setFault: (fault: FakeFault | undefined) => void;
	/** Every entry that currently exists, ordered by path. */
	readonly snapshot: () => RemoteEntry[];
	/** The text `write` put there. `undefined` for a file held as bytes. */
	readonly contentAt: (path: string) => string | undefined;
	/**
	 * A file as another tool would save it: any bytes, and no version check.
	 * A file already at the path keeps its id, as a save in place does; the
	 * version is renewed and the change is in the feed.
	 */
	readonly writeBytes: (path: string, bytes: Uint8Array) => RemoteEntry;
	/**
	 * What a wire stub serves as the download: the same lookup, faults and
	 * `NotFoundError` as `read`, without the decoding, which is the adapter's
	 * to do.
	 */
	readonly readBytes: (ref: EntryRef) => Promise<{ bytes: Uint8Array; version: string }>;
	readonly bytesAt: (path: string) => Uint8Array | undefined;
	/** Every call made, in order — lets a test assert what the engine did not do. */
	readonly callLog: () => readonly FakeCall[];
}

type CounterKey = 'id' | 'version' | 'seq' | 'tick' | 'call';

const SCAN = /^fake:s:(\d+):(\d+)$/;
const LOG = /^fake:l:(\d+)$/;

export const createFakeProvider = (options: FakeProviderOptions = {}): FakeProvider => {
	const {
		kind = 'dropbox',
		appVersion = '0.1.0',
		clientId = 'fake-client',
		userAgent,
		startAt = new Date('2026-01-01T00:00:00.000Z'),
		tickMs = 1000,
		pageSize = Number.POSITIVE_INFINITY,
		folderChanges = 'folder-only',
		listsEverything = true,
	} = options;

	/** Normalized path → node. The root is not stored; it always exists. */
	const nodes = new Map<string, FakeNode>();
	/** Ids of files this provider has deleted. Never reused, never resolved. */
	const retired = new Set<string>();
	/** Monotonic sequence → the entry as it looked at that moment. The delta feed. */
	const log = new Map<number, ChangeEntry>();
	const counters = new Map<CounterKey, number>();
	const opCounts = new Map<FakeOperation, number>();
	const rootIdBox = new Map<'rootId', string>();
	const faults = new Map<'fault', FakeFault>();
	const calls = new Map<number, FakeCall>();

	const bump = (key: CounterKey): number => {
		const next = (counters.get(key) ?? 0) + 1;
		counters.set(key, next);
		return next;
	};

	const iso = (): string => new Date(startAt.getTime() + bump('tick') * tickMs).toISOString();

	const bytesOf = (node: FakeNode): Uint8Array =>
		node.bytes ?? new TextEncoder().encode(node.content);

	const toEntry = (node: FakeNode): RemoteEntry => ({
		remoteId: node.remoteId,
		path: node.path,
		kind: node.kind,
		version: node.version,
		modifiedAt: node.modifiedAt,
		...(node.kind === 'file' ? { size: bytesOf(node).length } : {}),
	});

	/** Write a node into the tree and append the matching change record. */
	const put = (node: FakeNode): RemoteEntry => {
		nodes.set(node.path, node);
		log.set(bump('seq'), toEntry(node));
		return toEntry(node);
	};

	const drop = (node: FakeNode, record: boolean): void => {
		nodes.delete(node.path);
		// The fake knows the id, and reports it, but a `DeletedEntry` does not
		// promise one — Dropbox has none to give.
		if (record)
			log.set(bump('seq'), { path: node.path, deleted: true, remoteId: node.remoteId });
		retired.add(node.remoteId);
	};

	/**
	 * `remoteId` first, path only as a fallback. An entry whose path is stale
	 * because someone else moved the file still resolves — which is the whole
	 * reason an id is worth storing alongside the path.
	 *
	 * The fallback is not taken for an id this provider has *retired*. Ids are
	 * never reused here, so a caller naming one that has been deleted is naming
	 * a file that is gone, and an id-addressed provider (Drive, Graph) answers
	 * 404 rather than quietly acting on whatever now holds the path — which
	 * would be a stranger's file. Being the strictest provider in the repo is
	 * this fake's whole job: forgiveness here hides engine bugs rather than
	 * finding them.
	 */
	const resolve = (ref: EntryRef): FakeNode | undefined => {
		const byId = [...nodes.values()].find((node) => node.remoteId === ref.remoteId);
		if (byId !== undefined) return byId;
		if (retired.has(ref.remoteId)) return undefined;
		return nodes.get(normalizePath(ref.path));
	};

	const isFolder = (path: string): boolean => path === ROOT || nodes.get(path)?.kind === 'folder';

	const requireParent = (path: string): void => {
		const parent = parentPath(path);
		// Deliberately strict: Dropbox would create the missing folder, WebDAV
		// answers 409. Being strict is what forces the engine to queue the `mkdir`
		// its op queue already has a slot for.
		if (!isFolder(parent)) throw new NotFoundError(parent);
	};

	const descendantsOf = (path: string): FakeNode[] =>
		[...nodes.values()].filter((node) => node.path !== path && isWithin(node.path, path));

	const byPath = (a: FakeNode, b: FakeNode): number => a.path.localeCompare(b.path);

	const rootEntry = (): RemoteEntry => ({
		remoteId: rootIdBox.get('rootId') ?? 'id:root',
		path: ROOT,
		kind: 'folder',
		version: 'v0',
		modifiedAt: startAt.toISOString(),
	});

	/**
	 * Every operation below is synchronous inside. This gives it real promise
	 * semantics — a bare `throw` would reject before the caller ever held a
	 * promise — without an `async` that never awaits.
	 */
	const settle = <T>(op: FakeOperation, path: string | undefined, run: () => T): Promise<T> => {
		const attempt = (opCounts.get(op) ?? 0) + 1;
		opCounts.set(op, attempt);
		const call: FakeCall = { op, attempt, ...(path === undefined ? {} : { path }) };
		calls.set(bump('call'), call);

		try {
			const fault = faults.get('fault')?.(call);
			if (fault !== undefined) throw fault;
			return Promise.resolve(run());
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	};

	const ensureRoot = (): Promise<{ rootId: string }> =>
		settle('ensureRoot', undefined, () => {
			const id = rootIdBox.get('rootId') ?? 'id:root';
			rootIdBox.set('rootId', id);
			if (nodes.has(MARKER_FILE)) return { rootId: id };

			const marker = buildMarker({
				appVersion,
				provider: kind,
				clientId,
				now: new Date(iso()),
				...(userAgent === undefined ? {} : { userAgent }),
			});
			put({
				remoteId: `id:${String(bump('id'))}`,
				path: MARKER_FILE,
				kind: 'file',
				version: `v${String(bump('version'))}`,
				modifiedAt: iso(),
				content: serializeMarker(marker),
			});
			return { rootId: id };
		});

	const list = (folderPath: string): Promise<RemoteEntry[]> =>
		settle('list', folderPath, () => {
			const folder = normalizePath(folderPath);
			if (!isFolder(folder)) throw new NotFoundError(folder);
			return [...nodes.values()]
				.filter((node) => parentPath(node.path) === folder)
				.sort(byPath)
				.map(toEntry);
		});

	const fileAt = (ref: EntryRef): FakeNode => {
		const node = resolve(ref);
		if (node === undefined || node.kind === 'folder') throw new NotFoundError(ref.path);
		return node;
	};

	const readBytes = (ref: EntryRef): Promise<{ bytes: Uint8Array; version: string }> =>
		settle('read', ref.path, () => {
			const node = fileAt(ref);
			return { bytes: bytesOf(node), version: node.version };
		});

	// Decoded from the bytes whoever wrote them, as an adapter decodes a
	// download: text this fake was handed by `write` goes through the same
	// gate as a file planted by `writeBytes`, so a NUL the engine pushed is
	// refused here as it would be on the wire.
	const read = (ref: EntryRef): Promise<{ content: string; version: string }> =>
		settle('read', ref.path, () => {
			const node = fileAt(ref);
			return { content: decodeText(bytesOf(node), ref.path), version: node.version };
		});

	const writeBytes = (path: string, bytes: Uint8Array): RemoteEntry => {
		const target = normalizePath(path);
		if (target === ROOT) throw new NotFoundError(target);
		requireParent(target);
		const existing = nodes.get(target);
		if (existing?.kind === 'folder') throw new ConflictError(toEntry(existing));
		return put({
			remoteId: existing?.remoteId ?? `id:${String(bump('id'))}`,
			path: target,
			kind: 'file',
			version: `v${String(bump('version'))}`,
			modifiedAt: iso(),
			content: '',
			bytes,
		});
	};

	const write = (path: string, content: string, opts: WriteOptions): Promise<RemoteEntry> =>
		settle('write', path, () => {
			const target = normalizePath(path);
			if (target === ROOT) throw new NotFoundError(target);
			requireParent(target);

			const existing = nodes.get(target);
			if (existing?.kind === 'folder') throw new ConflictError(toEntry(existing));

			if (opts.expectedVersion === undefined) {
				if (existing !== undefined) throw new ConflictError(toEntry(existing));
				return put({
					remoteId: `id:${String(bump('id'))}`,
					path: target,
					kind: 'file',
					version: `v${String(bump('version'))}`,
					modifiedAt: iso(),
					content,
				});
			}

			if (existing === undefined) throw new NotFoundError(target);
			if (existing.version !== opts.expectedVersion) {
				throw new ConflictError(toEntry(existing));
			}
			return put({
				...existing,
				version: `v${String(bump('version'))}`,
				modifiedAt: iso(),
				content,
				// Text now, whatever it was: the bytes another tool left are gone.
				bytes: undefined,
			});
		});

	const createFolder = (path: string): Promise<RemoteEntry> =>
		settle('createFolder', path, () => {
			const target = normalizePath(path);
			if (target === ROOT) return rootEntry();

			const existing = nodes.get(target);
			// Idempotent, so a replayed `mkdir` op is harmless.
			if (existing?.kind === 'folder') return toEntry(existing);
			if (existing !== undefined) throw new ConflictError(toEntry(existing));

			requireParent(target);
			return put({
				remoteId: `id:${String(bump('id'))}`,
				path: target,
				kind: 'folder',
				version: `v${String(bump('version'))}`,
				modifiedAt: iso(),
				content: '',
			});
		});

	const move = (ref: EntryRef, newPath: string): Promise<RemoteEntry> =>
		settle('move', ref.path, () => {
			const node = resolve(ref);
			if (node === undefined) throw new NotFoundError(ref.path);

			const target = normalizePath(newPath);
			if (target === node.path) return toEntry(node);
			if (target === ROOT) throw new NotFoundError(target);
			if (node.kind === 'folder' && isWithin(target, node.path)) {
				throw new Error('a folder cannot be moved inside itself');
			}

			const occupant = nodes.get(target);
			if (occupant !== undefined) throw new ConflictError(toEntry(occupant));
			requireParent(target);

			// Descendants keep their versions: on a real provider a folder move does
			// not touch the contents of the files inside it. The folder itself gets a
			// new version, because OneDrive's eTag changes on a metadata-only edit
			// and an engine that assumed otherwise would break in Phase 3.
			const children = descendantsOf(node.path);
			const moved = children.map((child) => ({
				...child,
				path: rebasePath(child.path, node.path, target),
			}));

			drop(node, false);
			children.forEach((child) => {
				nodes.delete(child.path);
			});

			const entry = put({
				...node,
				path: target,
				version: `v${String(bump('version'))}`,
				modifiedAt: iso(),
			});
			moved.forEach((child) => {
				nodes.set(child.path, child);
				if (folderChanges === 'recursive') log.set(bump('seq'), toEntry(child));
			});
			return entry;
		});

	const remove = (ref: EntryRef): Promise<void> =>
		settle('delete', ref.path, () => {
			const node = resolve(ref);
			// Idempotent: a push queue that crashed mid-drain must be replayable.
			if (node === undefined) return;

			descendantsOf(node.path).forEach((child) => {
				drop(child, folderChanges === 'recursive');
			});
			drop(node, true);
		});

	const scanPage = (offset: number, seqAtStart: number): ChangeSet => {
		const all = [...nodes.values()].sort(byPath).map(toEntry);
		const page = all.slice(offset, offset + pageSize);
		const next = offset + page.length;
		const done = next >= all.length;
		return {
			entries: page,
			cursor: done
				? `fake:l:${String(seqAtStart)}`
				: `fake:s:${String(next)}:${String(seqAtStart)}`,
			more: !done,
		};
	};

	const logPage = (after: number): ChangeSet => {
		const pending = [...log.entries()].filter(([seq]) => seq > after).sort(([a], [b]) => a - b);
		const page = pending.slice(0, pageSize);
		const last = page.at(-1)?.[0] ?? after;
		return {
			entries: page.map(([, entry]) => entry),
			cursor: `fake:l:${String(last)}`,
			more: page.length < pending.length,
		};
	};

	const changes = (cursor?: string): Promise<ChangeSet> =>
		settle('changes', undefined, () => {
			// A cold start scans current state rather than replaying history: a new
			// device must not be told about files that no longer exist.
			if (cursor === undefined) return scanPage(0, counters.get('seq') ?? 0);

			const scan = SCAN.exec(cursor);
			if (scan !== null) return scanPage(Number(scan[1]), Number(scan[2]));

			const tail = LOG.exec(cursor);
			if (tail !== null) return logPage(Number(tail[1]));

			throw new CursorResetError('unusable cursor');
		});

	return {
		kind,
		listsEverything,
		ensureRoot,
		list,
		read,
		write,
		createFolder,
		move,
		delete: remove,
		changes,
		setFault: (fault) => {
			if (fault === undefined) faults.delete('fault');
			if (fault !== undefined) faults.set('fault', fault);
		},
		snapshot: () => [...nodes.values()].sort(byPath).map(toEntry),
		contentAt: (path) => {
			const node = nodes.get(normalizePath(path));
			return node?.bytes === undefined ? node?.content : undefined;
		},
		writeBytes,
		readBytes,
		bytesAt: (path) => {
			const node = nodes.get(normalizePath(path));
			return node === undefined || node.kind === 'folder' ? undefined : bytesOf(node);
		},
		callLog: () => [...calls.values()],
	};
};
