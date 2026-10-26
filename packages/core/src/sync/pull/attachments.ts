import { basename, parentPath, rebasePath } from '../../paths.js';
import { type DeletedEntry, type RemoteEntry } from '../../providers/types.js';
import { conflictFilePath } from '../conflicts.js';
import { type EngineContext } from '../context.js';
import { type PullChange, type SyncOp } from '../store.js';
import { aliveElsewhere, type Batch, listedAfter, type Step } from './batch.js';
import { type FileBase, fileGone, type FilePlace, placedFiles, startingFiles } from './files.js';

/**
 * The files that are not notes, as a pull decides them: what the batch
 * starts from (`fileBaseOf`) and where its decisions so far leave each
 * (`filesNow`), a listed file placed or adopted (`decideAttachment`), one
 * the remote no longer has or has turned into a note (`fileNoLonger`,
 * `deletedFile`, `fileUnderMoved`), and two rows left on one path
 * (`settleFileClashes`). Moved out of `engine.ts` as they were (#446).
 */

export const createPullAttachments = ({ store, now, newId }: EngineContext) => {
	const fileBaseOf = async (queue: readonly SyncOp[]): Promise<FileBase> => ({
		rows: await store.allFiles(),
		moves: queue.reduce<Map<string, string>>(
			(map, op) =>
				op.op !== 'move-file' || map.has(op.fileId) ? map : map.set(op.fileId, op.path),
			new Map()
		),
		deleting: new Set(queue.flatMap((op) => (op.op === 'delete-file' ? [op.remoteId] : []))),
	});

	/** The rows a folder's deletion left with no file (`FilePlace.stranded`). */
	const strandedFiles = ({ batch, decided }: Pick<Step, 'batch' | 'decided'>): PullChange[] =>
		[...filesNow(batch.files, decided).values()].flatMap((file) =>
			file.stranded ? [fileGone(file)] : []
		);

	/**
	 * The last view asked for, per batch, and the decisions it was reached
	 * through. A batch's decisions only ever grow at the end, and each file
	 * entry asks once: replayed from the start every time, a scan of a
	 * thousand files would be a million steps.
	 */
	const fileViews = new WeakMap<
		FileBase,
		{ decided: readonly PullChange[]; view: ReadonlyMap<string, FilePlace> }
	>();

	/** The files once the decisions so far have been applied, by row id. */
	const filesNow = (
		base: FileBase,
		decided: readonly PullChange[]
	): ReadonlyMap<string, FilePlace> => {
		const known = fileViews.get(base);
		const from =
			known !== undefined &&
			known.decided.length <= decided.length &&
			known.decided.every((change, index) => decided[index] === change)
				? known
				: { decided: [], view: startingFiles(base) };
		const view = decided.slice(from.decided.length).reduce(placedFiles, from.view);
		fileViews.set(base, { decided, view });
		return view;
	};

	/**
	 * A free name beside `path` for a file that has to step out of the way,
	 * against the rows the batch has left in that folder and the paths it is
	 * bringing in. Its own extension kept, so it stays the kind of file it is.
	 */
	const freeFilePath = (
		path: string,
		view: ReadonlyMap<string, FilePlace>,
		batch: Batch
	): string => {
		const folder = parentPath(path);
		const taken = [...[...view.values()].map((file) => file.at), ...batch.claimed]
			.filter((each) => parentPath(each) === folder)
			.map(basename);
		return conflictFilePath(path, now(), taken);
	};

	/**
	 * The rows in the way of a file arriving at `path`, other than its own. The
	 * remote keeps the path (CLAUDE.md). A row whose file is not there steps
	 * aside: one never sent, whose upload goes to the new name, and one the
	 * user moved here, whose move does. A row whose file *was* there is let go
	 * of — its file is gone from the path, and a bound row is only the
	 * remote's word — unless the batch says later where it went, and then its
	 * own entry takes it there.
	 */
	const clearFilePath = (
		path: string,
		own: string | undefined,
		{ batch, decided, at }: Step
	): PullChange[] =>
		[...filesNow(batch.files, decided).values()]
			.filter((file) => file.at === path && file.id !== own)
			.reduce<PullChange[]>((changes, file) => {
				if (file.remoteId === undefined || file.moving) {
					const view = filesNow(batch.files, [...decided, ...changes]);
					const aside = freeFilePath(path, view, batch);
					return [...changes, { kind: 'displace-file', fileId: file.id, path: aside }];
				}
				const later = listedAfter(batch.listed, file.remoteId, at);
				return later ? changes : [...changes, { kind: 'delete-file', fileId: file.id }];
			}, []);

	/**
	 * A file that is not a note, listed. Matched by its id; then by a pending
	 * row at its path, the same file if it is the same size — an upload whose
	 * answer never came, or the same picture added on two devices — which is
	 * adopted rather than sent again; otherwise a new row.
	 */
	const decideAttachment = (entry: RemoteEntry, { batch, decided, at }: Step): PullChange[] => {
		// The user has deleted it here, and the delete has not run: what the
		// remote says of it is old news, and the store would pass it over.
		if (batch.files.deleting.has(entry.remoteId)) return [];
		const taken = originsTaken(entry, { batch, decided, at });
		return [
			...taken,
			...placeAttachment(entry, { batch, decided: [...decided, ...taken], at }),
		];
	};

	/**
	 * Rows the user moved away from where `entry` now is, whose file is no
	 * longer the one there: another has the name, and the batch does not say
	 * the old one went anywhere. A feed can report a file put in place of
	 * another and never the deletion of the one it replaced, which
	 * `clearFilePath` answers for a row still at the path; for a row the user
	 * moved away, the move would find nothing to move and leave the row bound
	 * to nothing. Gone, as a deletion would have said (#194).
	 */
	const originsTaken = (entry: RemoteEntry, { batch, decided, at }: Step): PullChange[] =>
		[...filesNow(batch.files, decided).values()].flatMap((file) => {
			if (!file.moving || file.remoteId === undefined || file.remote !== entry.path)
				return [];
			const later = listedAfter(batch.listed, file.remoteId, at);
			return file.remoteId === entry.remoteId || later ? [] : [fileGone(file)];
		});

	const placeAttachment = (entry: RemoteEntry, { batch, decided, at }: Step): PullChange[] => {
		const view = [...filesNow(batch.files, decided).values()];
		const size = entry.size ?? 0;
		const own = view.find((file) => file.remoteId === entry.remoteId);
		if (own !== undefined) {
			const same =
				own.remote === entry.path && own.version === entry.version && own.size === size;
			if (same) return [];
			// Moved here by the user and not yet there: the row stays put, as
			// the store keeps it, and nothing is in the way of a file not coming.
			if (own.moving) {
				return [{ kind: 'upsert-file', fileId: own.id, path: own.at, remote: entry }];
			}
			return [
				...clearFilePath(entry.path, own.id, { batch, decided, at }),
				{ kind: 'upsert-file', fileId: own.id, path: entry.path, remote: entry },
			];
		}
		const pending = view.find(
			(file) => file.at === entry.path && file.remoteId === undefined && file.size === size
		);
		if (pending !== undefined) {
			return [
				{
					kind: 'upsert-file',
					fileId: pending.id,
					path: entry.path,
					remote: entry,
					adopt: true,
				},
			];
		}
		return [
			...clearFilePath(entry.path, undefined, { batch, decided, at }),
			{ kind: 'upsert-file', fileId: newId(), path: entry.path, remote: entry },
		];
	};

	/** The other way round: a file renamed into a note. Its row goes. */
	const fileNoLonger = (
		entry: RemoteEntry,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): PullChange[] => {
		const file = [...filesNow(batch.files, decided).values()].find(
			(each) => each.remoteId === entry.remoteId
		);
		return file === undefined ? [] : [{ kind: 'delete-file', fileId: file.id }];
	};

	/**
	 * A deletion about a file row: by its id, or — Dropbox's, which is a path
	 * and nothing else — by where its file is on the remote. `undefined` for
	 * one about no file, which the rest of `decideDeletedRow` asks about notes
	 * and folders. As for a note, a thing the batch says lives on elsewhere was
	 * moved, not deleted (`movedNotDeleted`).
	 */
	const deletedFile = (
		{ path, remoteId }: DeletedEntry,
		{ batch, decided, at }: Step
	): PullChange[] | undefined => {
		const rows = [...filesNow(batch.files, decided).values()];
		const file =
			remoteId === undefined
				? rows.find((each) => each.remoteId !== undefined && each.remote === path)
				: rows.find((each) => each.remoteId === remoteId);
		if (file?.remoteId === undefined) return undefined;
		const here = path !== undefined && file.remote === path;
		const alive = here
			? listedAfter(batch.listed, file.remoteId, at)
			: aliveElsewhere(batch.listed, file.remoteId, path, at);
		return alive ? [] : [fileGone(file)];
	};

	/**
	 * A deletion by path under a folder this batch moves: the row went with
	 * the folder, so it is found at the path rebased. Whether the file moved
	 * with the folder or was deleted out of it first, the batch answers — the
	 * file is listed again by its own entry if it lives (`forgetMovedUnder`).
	 */
	const fileUnderMoved = (
		path: string,
		over: Readonly<{ from: string; to: string }>,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): PullChange[] => {
		const was = rebasePath(path, over.from, over.to);
		const file = [...filesNow(batch.files, decided).values()].find(
			(each) => each.remoteId !== undefined && each.remote === was
		);
		if (file?.remoteId === undefined || batch.listed.has(file.remoteId)) return [];
		return [fileGone(file)];
	};

	/**
	 * Two rows on one path once a batch is decided, which nothing above means
	 * to leave: a pending row a deletion kept, and a notebook renamed onto its
	 * name by an entry that lists none of its files; or a shape nobody has
	 * found. The first row bound there, and not on its way elsewhere, keeps
	 * the path, and where there is none the first row does. One never sent, or
	 * on its way elsewhere, steps aside. Another bound there goes: which of
	 * two such rows the file really is, nothing in the batch says any more,
	 * and the wrong one costs a picture that does not show until a scan.
	 */
	const settleFileClashes = ({
		batch,
		decided,
	}: Pick<Step, 'batch' | 'decided'>): PullChange[] => {
		const groups = [...filesNow(batch.files, decided).values()].reduce<
			Map<string, FilePlace[]>
		>((map, file) => map.set(file.at, [...(map.get(file.at) ?? []), file]), new Map());
		return [...groups.values()]
			.filter((group) => group.length > 1)
			.reduce<PullChange[]>((changes, group) => {
				const keeper =
					group.find((file) => file.remoteId !== undefined && !file.moving) ?? group[0];
				return group
					.filter((file) => file !== keeper)
					.reduce<PullChange[]>((more, file) => {
						if (file.remoteId !== undefined && !file.moving) {
							return [...more, { kind: 'delete-file', fileId: file.id }];
						}
						const view = filesNow(batch.files, [...decided, ...more]);
						const aside = freeFilePath(file.at, view, batch);
						return [...more, { kind: 'displace-file', fileId: file.id, path: aside }];
					}, changes);
			}, []);
	};

	return {
		fileBaseOf,
		strandedFiles,
		filesNow,
		decideAttachment,
		fileNoLonger,
		deletedFile,
		fileUnderMoved,
		settleFileClashes,
	};
};

/** What the pull's other parts are handed of it. */
export type PullAttachments = ReturnType<typeof createPullAttachments>;
