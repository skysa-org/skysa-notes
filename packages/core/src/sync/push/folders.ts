import { foldName } from '../../markdown/slug.js';
import { normalizePath, parentPath, ROOT } from '../../paths.js';
import { type EngineContext } from '../context.js';
import { orIfNotFound } from '../providerOps.js';
import { type SyncOpOf } from '../store.js';

/**
 * The remote's folders, as a push needs them: made, a level at a time,
 * before a write that needs one (`ensureRemoteFolder`), and removed or left
 * once a notebook deleted here is empty there (`runRmdir`). Moved out of
 * `engine.ts` as they were (#446).
 */

export const createFolderPush = ({ provider, store }: EngineContext) => {
	/**
	 * The folder chain a path needs, made from the top down. `createFolder` is
	 * idempotent by contract, but it is not recursive on every provider — the
	 * fake is deliberately strict about parents for exactly this reason — so a
	 * nested notebook has to be made a level at a time.
	 */
	const ensureRemoteFolder = (path: string): Promise<void> => {
		if (normalizePath(path) === ROOT) return Promise.resolve();
		const key = foldName(normalizePath(path));
		const already = making.get(key);
		if (already !== undefined) return already;
		const made = ensureRemoteFolder(parentPath(path)).then(async () => {
			await provider.createFolder(path);
		});
		making.set(key, made);
		// A folder that could not be made is asked for again by the next write
		// that needs it, not failed on this one's word.
		void made.catch(() => {
			making.delete(key);
		});
		return made;
	};

	/**
	 * The folders made, or being made, for the turn of the drain under way, by
	 * folded path: so writes sent together (`sendTogether`) that each find their
	 * notebook missing — deleted on another device while they had edits — make
	 * it once between them. Each making it, Google Drive made one apiece: its
	 * `createFolder` asks first whether the folder is there, and none of them
	 * was yet. Emptied at every turn (`startTurn`, from `drainOps`), so a folder
	 * removed since is asked about again.
	 */
	const making = new Map<string, Promise<void>>();

	/** A new turn of the drain: no folder is being made for it yet. */
	const startTurn = (): void => {
		making.clear();
	};

	/**
	 * Does the remote hold any file at or under this folder? Hidden ones count:
	 * the point is that nothing of the user's goes with the folder, and a file
	 * this device has never pulled is exactly what must not.
	 *
	 * A folder that cannot be listed is treated as holding nothing — it is not
	 * there to hold anything — and the delete that follows answers "not found"
	 * the same way.
	 */
	const holdsNoFile = async (path: string): Promise<boolean> => {
		const entries = await orIfNotFound(provider.list(path), []);
		if (entries.some((entry) => entry.kind === 'file')) return false;
		return noneOfTheseHolds(
			entries.flatMap((entry) => (entry.kind === 'folder' ? [entry.path] : []))
		);
	};

	/**
	 * One subfolder at a time, stopping at the first file. In parallel it would
	 * be quicker, but this is the only walk in the engine whose depth is the
	 * user's to choose: a deep notebook would put an unbounded number of
	 * listings at the provider at once — on Drive each one is a path walk and a
	 * paged search — and every subtree would be read to the bottom even once the
	 * answer was known.
	 */
	const noneOfTheseHolds = async (paths: readonly string[]): Promise<boolean> => {
		const [head, ...rest] = paths;
		if (head === undefined) return true;
		return (await holdsNoFile(head)) ? noneOfTheseHolds(rest) : false;
	};

	/**
	 * A notebook deleted or renamed here, whose directory is still on the
	 * remote. The notes inside went up as deletes or moves of their own, ahead
	 * of this, so what is left is an empty directory — and left alone it comes
	 * back as a notebook on the next pull that reports it, and stays in every
	 * other client's folder list.
	 *
	 * It **never deletes files this device has not pulled**, which is the whole
	 * difficulty: the remote may hold anything under that path — a file another
	 * device wrote a moment ago, or one the user dropped in from outside the
	 * app. So the op is refused at five gates before it sends anything:
	 *
	 * 1. A provider whose listings are not the whole truth about a folder is
	 *    never asked to delete one: `listsEverything` is false on Drive, where
	 *    the app cannot see what the user put in the folder themselves, so
	 *    nothing there can be shown to be empty. There the folder is *left*
	 *    instead (`leaveFolder`), past the same gates: marked, with nothing in
	 *    it touched, and hidden on every device while it holds nothing the app
	 *    can see. A provider that can do neither keeps the directory.
	 * 2. Without the id recorded when it was queued, nothing: a folder cannot be
	 *    confirmed as the one this op is about by its path alone.
	 * 3. A folder row at the path, or a live note or a file row at or under
	 *    it: the user has made the notebook again, or has a file there still to
	 *    send or still to move out, and it is theirs now.
	 * 4. Nothing at the name on the remote, or something with another id — it was
	 *    renamed or replaced elsewhere — and the op is about a folder that is
	 *    already gone.
	 * 5. Anything at all under it that is a file — on Drive, that the app can
	 *    see, which is all a mark needs: it hides nothing that holds a file.
	 *
	 * Known gap (docs/ARCHITECTURE.md §7): a file written between the walk and the
	 * delete goes with the folder, into the provider's trash or recycle bin.
	 */
	const runRmdir = async (op: SyncOpOf<'rmdir'>): Promise<void> => {
		const { remoteId } = op;
		const finish = (): Promise<void> => store.completeOp(op.seq, { kind: 'done' });
		const remove = provider.listsEverything ? provider.delete : provider.leaveFolder;
		if (remove === undefined) return finish();
		// The app folder itself is never a row and never removed (`reconcile`,
		// `decideFolder`): an op for it could only be a mistake, and the mistake
		// would take every note the user has.
		if (remoteId === undefined || normalizePath(op.path) === ROOT) return finish();
		const mine = await store.folderByPath(op.path);
		const notes = await store.notesUnder(op.path);
		const files = await store.filesUnder(op.path);
		if (mine !== undefined || notes.length > 0 || files.length > 0) return finish();

		const beside = await orIfNotFound(provider.list(parentPath(op.path)), []);
		const there = beside.find((entry) => entry.remoteId === remoteId);
		// A folder, at that path: an id that named a file would otherwise take
		// the file with the same call.
		if (
			there === undefined ||
			there.kind !== 'folder' ||
			normalizePath(there.path) !== normalizePath(op.path)
		) {
			return finish();
		}
		if (!(await holdsNoFile(op.path))) return finish();

		await orIfNotFound(remove({ remoteId, path: op.path }), undefined);
		return finish();
	};

	return { ensureRemoteFolder, startTurn, runRmdir };
};

/** What the push's other parts are handed of it. */
export type FolderPush = ReturnType<typeof createFolderPush>;
