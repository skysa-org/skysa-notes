import { isWithin, normalizePath, parentPath, rebasePath, ROOT } from '../../src/paths.js';
import type {
	ConflictResolution,
	OpOutcome,
	PullBatch,
	PullChange,
	SyncFolder,
	SyncNote,
	SyncOp,
	SyncStore,
} from '../../src/sync/store.js';

/**
 * A `SyncStore` in memory. This is what every engine test drives, and — like
 * the fake provider — it is deliberately the strictest implementation in the
 * repo: it throws where the port leaves something undefined, so an engine that
 * relies on a convenience nobody promised fails here rather than in a browser.
 *
 * It also enforces the one promise the port makes that a lazy implementation
 * would quietly drop: `applyPull` is all-or-nothing, cursor included.
 */

export interface MemoryStore extends SyncStore {
	readonly notes: () => SyncNote[];
	readonly folders: () => SyncFolder[];
	readonly ops: () => SyncOp[];
	readonly storedCursor: () => string | undefined;
	/** Seed a note as though it were already synced, or already edited. */
	readonly put: (note: Partial<SyncNote> & Pick<SyncNote, 'id' | 'path' | 'content'>) => void;
	readonly putFolder: (folder: SyncFolder) => void;
	readonly queue: (op: Omit<SyncOp, 'seq' | 'attempts'> & { attempts?: number }) => SyncOp;
	/** Fail the next `applyPull`, to prove the cursor does not move without it. */
	readonly breakNextApply: () => void;
	/**
	 * Every no-op the contract required this store to tolerate. The contract
	 * says a `delete-note` for an id that is not here must succeed, because a
	 * batch that rejects is a batch that is retried for ever — but an engine
	 * that emits one is still wrong, so the engine tests assert this is empty
	 * and the strictness is kept without the deadlock.
	 */
	readonly anomalies: () => string[];
	readonly lastError: (seq: number) => string | undefined;
}

export const createMemoryStore = (): MemoryStore => {
	const notes = new Map<string, SyncNote>();
	const folders = new Map<string, SyncFolder>();
	const ops = new Map<number, SyncOp & { lastError?: string }>();
	const state = new Map<'cursor', string>();
	const counters = new Map<'seq', number>();
	const flags = new Map<'break', boolean>();
	const anomalies: string[] = [];

	const nextSeq = (): number => {
		const seq = (counters.get('seq') ?? 0) + 1;
		counters.set('seq', seq);
		return seq;
	};

	const requireNote = (id: string): SyncNote => {
		const note = notes.get(id);
		if (note === undefined) throw new Error(`no note ${id}`);
		return note;
	};

	const ensureFolderChain = (path: string): void => {
		if (path === ROOT || folders.has(path)) return;
		ensureFolderChain(parentPath(path));
		folders.set(path, { path });
	};

	const queue = (input: Omit<SyncOp, 'seq' | 'attempts'> & { attempts?: number }): SyncOp => {
		const op: SyncOp = { seq: nextSeq(), attempts: 0, ...input };
		ops.set(op.seq, op);
		return op;
	};

	const applyConflict = (resolution: ConflictResolution): void => {
		const note = requireNote(resolution.noteId);
		// The remote takes the path it claims, which is not necessarily the one
		// the local note was at: a note can be moved and edited between syncs.
		notes.set(note.id, {
			...note,
			path: resolution.remote.path,
			content: resolution.remoteContent,
			remoteId: resolution.remote.remoteId,
			remoteVersion: resolution.remote.version,
			dirty: false,
		});
		if (notes.has(resolution.copyId)) throw new Error(`copy id ${resolution.copyId} is taken`);
		ensureFolderChain(parentPath(resolution.copyPath));
		notes.set(resolution.copyId, {
			id: resolution.copyId,
			path: resolution.copyPath,
			content: resolution.copyContent,
			dirty: true,
		});
		// The copy only exists locally, so it needs a push of its own.
		queue({ op: 'write', noteId: resolution.copyId, path: resolution.copyPath });
	};

	const noteAt = (path: string): SyncNote | undefined =>
		[...notes.values()].find((note) => note.path === path);

	/**
	 * What a folder delete does to one note inside it. A dirty note survives as
	 * a local-only note rather than being thrown away with the folder: an
	 * unsaved edit outranks a remote deletion (CLAUDE.md — never lose user data).
	 */
	const detachOrDelete = (note: SyncNote): void => {
		if (!note.dirty) {
			notes.delete(note.id);
			return;
		}
		const { remoteId: _id, remoteVersion: _version, ...rest } = note;
		notes.set(note.id, rest);
	};

	const applyChange = (change: PullChange): void => {
		if (change.kind === 'upsert-note') {
			// The engine names the note; the store never guesses. Matching on the
			// path here instead would overwrite whatever note happened to be
			// sitting at a path the remote has since reused.
			ensureFolderChain(parentPath(change.path));
			notes.set(change.id, {
				id: change.id,
				path: change.path,
				content: change.content,
				remoteId: change.remote.remoteId,
				remoteVersion: change.remote.version,
				dirty: false,
			});
			return;
		}
		if (change.kind === 'adopt-version') {
			const note = requireNote(change.id);
			notes.set(note.id, {
				...note,
				remoteId: change.remote.remoteId,
				remoteVersion: change.remote.version,
			});
			return;
		}
		if (change.kind === 'move-note') {
			const note = requireNote(change.id);
			ensureFolderChain(parentPath(change.path));
			notes.set(note.id, {
				...note,
				path: change.path,
				remoteId: change.remote.remoteId,
				remoteVersion: change.remote.version,
			});
			return;
		}
		if (change.kind === 'delete-note' || change.kind === 'detach-note') {
			const note = notes.get(change.id);
			// Already gone. Saying so twice is a no-op, not a failure: see
			// `anomalies` above.
			if (note === undefined) {
				anomalies.push(`${change.kind} for unknown note ${change.id}`);
				return;
			}
			if (change.kind === 'delete-note') {
				notes.delete(note.id);
				return;
			}
			const { remoteId: _id, remoteVersion: _version, ...rest } = note;
			notes.set(change.id, rest);
			return;
		}
		if (change.kind === 'ensure-folder') {
			// The app folder is not a notebook and holds no row. A store that
			// kept one would have it reconciled away after the next cursor
			// reset — and since every path is within the root, that one
			// `delete-folder` is every note on the device.
			if (change.path === ROOT) {
				anomalies.push('ensure-folder for the root');
				return;
			}
			ensureFolderChain(parentPath(change.path));
			folders.set(change.path, {
				path: change.path,
				...(change.remoteId === undefined ? {} : { remoteId: change.remoteId }),
			});
			return;
		}
		if (change.kind === 'move-folder') {
			applyFolderMove(change.from, change.to, change.remoteId);
			return;
		}
		if (change.kind === 'displace-note') {
			// Contents and dirty flag untouched: the note is only being moved out
			// of the way, and it is the user's writing.
			const note = notes.get(change.id);
			if (note === undefined) {
				anomalies.push(`displace-note for unknown note ${change.id}`);
				return;
			}
			ensureFolderChain(parentPath(change.path));
			notes.set(note.id, { ...note, path: change.path });
			return;
		}
		if (change.kind === 'delete-folder') {
			if (normalizePath(change.path) === ROOT) {
				anomalies.push('delete-folder for the root');
				return;
			}
			// Everything beneath it, not just the row itself: a folder that is
			// gone remotely cannot leave its subfolders behind, and it cannot
			// leave its notes floating at paths whose folder no longer exists.
			const gone = [...folders.values()].filter((folder) =>
				isWithin(folder.path, change.path)
			);
			for (const folder of gone) folders.delete(folder.path);
			const inside = [...notes.values()].filter((note) => isWithin(note.path, change.path));
			for (const note of inside) detachOrDelete(note);
			return;
		}
		applyConflict(change.resolution);
	};

	const applyFolderMove = (from: string, to: string, remoteId?: string): void => {
		for (const folder of [...folders.values()]) {
			if (!isWithin(folder.path, from)) continue;
			folders.delete(folder.path);
			const path = rebasePath(folder.path, from, to);
			folders.set(path, {
				path,
				...(folder.path === from && remoteId !== undefined
					? { remoteId }
					: folder.remoteId === undefined
						? {}
						: { remoteId: folder.remoteId }),
			});
		}
		// Notes move with the folder even when dirty: the move is metadata and
		// cannot conflict with an edit to the contents (docs/PLAN.md §7).
		for (const note of [...notes.values()]) {
			if (isWithin(note.path, from)) {
				notes.set(note.id, { ...note, path: rebasePath(note.path, from, to) });
			}
		}
		// And so do the ops that name them, or a queued write would land at a
		// path that no longer exists.
		for (const op of [...ops.values()]) {
			ops.set(op.seq, {
				...op,
				path: isWithin(op.path, from) ? rebasePath(op.path, from, to) : op.path,
				...(op.targetPath !== undefined && isWithin(op.targetPath, from)
					? { targetPath: rebasePath(op.targetPath, from, to) }
					: {}),
			});
		}
	};

	const settle = (outcome: OpOutcome): void => {
		if (outcome.kind === 'done') return;
		if (outcome.kind === 'purged') {
			notes.delete(outcome.noteId);
			return;
		}
		const note = requireNote(outcome.noteId);
		if (outcome.kind === 'moved') {
			notes.set(note.id, {
				...note,
				path: outcome.remote.path,
				remoteId: outcome.remote.remoteId,
				remoteVersion: outcome.remote.version,
			});
			return;
		}
		notes.set(note.id, {
			...note,
			path: outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
			// Typed again while the request was in flight. The bytes on the
			// remote are not the bytes here, so the note is still dirty and the
			// next push has something to do.
			dirty: note.content !== outcome.content,
		});
	};

	const snapshot = () => ({
		notes: new Map(notes),
		folders: new Map(folders),
		ops: new Map(ops),
		cursor: state.get('cursor'),
	});

	const restore = (saved: ReturnType<typeof snapshot>): void => {
		notes.clear();
		folders.clear();
		ops.clear();
		for (const [key, value] of saved.notes) notes.set(key, value);
		for (const [key, value] of saved.folders) folders.set(key, value);
		for (const [key, value] of saved.ops) ops.set(key, value);
		if (saved.cursor === undefined) state.delete('cursor');
		else state.set('cursor', saved.cursor);
	};

	return {
		cursor: () => Promise.resolve(state.get('cursor')),
		noteById: (id) => Promise.resolve(notes.get(id)),
		noteByPath: (path) => Promise.resolve(noteAt(path)),
		noteByRemoteId: (remoteId) =>
			Promise.resolve([...notes.values()].find((note) => note.remoteId === remoteId)),
		allNotes: () => Promise.resolve([...notes.values()]),
		notesUnder: (folderPath) =>
			Promise.resolve([...notes.values()].filter((note) => isWithin(note.path, folderPath))),
		folderByRemoteId: (remoteId) =>
			Promise.resolve([...folders.values()].find((folder) => folder.remoteId === remoteId)),
		folderByPath: (path) => Promise.resolve(folders.get(path)),
		foldersWithRemote: () =>
			Promise.resolve(
				[...folders.values()].filter((folder) => folder.remoteId !== undefined)
			),

		applyPull: (batch: PullBatch) => {
			const before = snapshot();
			try {
				if (flags.get('break') === true) {
					flags.delete('break');
					throw new Error('store write failed');
				}
				for (const change of batch.changes) applyChange(change);
				if (batch.cursor !== undefined) state.set('cursor', batch.cursor);
			} catch (error) {
				// All or nothing, cursor included — the promise the engine is
				// relying on when it hands over a batch and a cursor together.
				restore(before);
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return Promise.resolve();
		},

		pendingOps: () => Promise.resolve([...ops.values()].sort((a, b) => a.seq - b.seq)),
		completeOp: (seq, outcome) => {
			if (!ops.has(seq)) return Promise.reject(new Error(`no op ${String(seq)}`));
			settle(outcome);
			ops.delete(seq);
			return Promise.resolve();
		},
		failOp: (seq, error) => {
			const op = ops.get(seq);
			if (op === undefined) return Promise.reject(new Error(`no op ${String(seq)}`));
			ops.set(seq, { ...op, attempts: op.attempts + 1, lastError: error });
			return Promise.resolve();
		},
		resolveConflict: (seq, resolution) => {
			if (!ops.has(seq)) return Promise.reject(new Error(`no op ${String(seq)}`));
			applyConflict(resolution);
			ops.delete(seq);
			return Promise.resolve();
		},

		notes: () => [...notes.values()].sort((a, b) => a.path.localeCompare(b.path)),
		folders: () => [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)),
		ops: () => [...ops.values()].sort((a, b) => a.seq - b.seq),
		storedCursor: () => state.get('cursor'),
		put: (note) => {
			ensureFolderChain(parentPath(note.path));
			notes.set(note.id, { dirty: false, ...note });
		},
		putFolder: (folder) => {
			ensureFolderChain(parentPath(folder.path));
			folders.set(folder.path, folder);
		},
		queue,
		breakNextApply: () => {
			flags.set('break', true);
		},
		lastError: (seq) => ops.get(seq)?.lastError,
		anomalies: () => [...anomalies],
	};
};
