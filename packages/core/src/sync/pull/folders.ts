import {
	ancestorPaths,
	basename,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	rebasePath,
	ROOT,
} from '../../paths.js';
import { type ChangeEntry, type RemoteEntry } from '../../providers/types.js';
import { conflictFolderPath, conflictPath } from '../conflicts.js';
import { type EngineContext } from '../context.js';
import { findFreeName, FREE_PATH_ATTEMPTS } from '../names.js';
import { type PullChange, type SyncFolder, type SyncNote } from '../store.js';
import { type PullAttachments } from './attachments.js';
import { aliveElsewhere, leavesFor, listedAfter, type LiveEntries, type Step } from './batch.js';
import { type Cascade } from './cascade.js';
import { type Occupancy } from './occupancy.js';
import { folderBefore, folderNow, remoteNow } from './replay.js';

/**
 * The folders, as a pull decides them: a listed folder made, moved or left
 * as it is (`decideFolder`), the folder or the notes in the way of one moved
 * out of it first (`clearTheWay`, `clearTheNotes`), a folder another moved
 * onto (`movedFolderOver`), and one deleted once what it holds that the batch
 * keeps is rescued (`deleteFolderAfterRescue`, `doomedFolder`). Moved out of
 * `engine.ts` as they were (#446).
 */

/** One decision, as the pull reaches it: `decide` in `decide.ts`, handed in. */
export type Decide = (entry: ChangeEntry, step: Step) => Promise<PullChange[]>;

export const createPullFolders = (
	{ store, now }: EngineContext,
	{
		decide,
		cascadeOver,
		filesNow,
		notesUnderNow,
		takenIn,
	}: { decide: Decide } & Pick<Cascade, 'cascadeOver'> &
		Pick<PullAttachments, 'filesNow'> &
		Pick<Occupancy, 'notesUnderNow' | 'takenIn'>
) => {
	type MovedOver =
		Readonly<{ kind: 'itself' }> | Readonly<{ kind: 'under'; from: string; to: string }>;

	/**
	 * A deletion that names nothing but a path — Dropbox's `DeletedMetadata` —
	 * of a folder this batch also says is alive somewhere else, or of something
	 * under one. `itself`: the folder at the path is not gone, since Dropbox
	 * reports a rename as the old path deleted and the new one listed, and the
	 * entry for the new one moves it. `under`: the nearest such folder above
	 * the path, and the last place the batch gives it, for `decideUnderMoved`
	 * to ask the provider about.
	 *
	 * A deletion that does carry an id is answered by `movedNotDeleted`, and is
	 * not second-guessed here: the provider knew the file well enough to name it.
	 */
	const movedFolderOver = async (
		path: string | undefined,
		remoteId: string | undefined,
		live: LiveEntries,
		{ decided, at }: Pick<Step, 'decided' | 'at'>
	): Promise<MovedOver | undefined> => {
		if (remoteId !== undefined || path === undefined) return undefined;
		// Nearest first: the folder closest above the path is the one whose
		// last place says where the path went. `ancestorPaths` is outermost
		// first, and rebased through an outer folder alone, `C/C/B` under `C`
		// renamed to `A` and `C/C` to `A/B` is looked for in an `A/C` no
		// longer there.
		const candidates = [
			path,
			...ancestorPaths(path).reduceRight<string[]>((all, each) => [...all, each], []),
		];
		// The folder the batch has put there, where that is a different one
		// from the folder there when the batch started: `C` renamed to `D`
		// and back, with `C` and then `D` deleted by path, is one folder alive
		// at `C` both times, and nothing was at `D` before the batch. Otherwise
		// the one there before, which a rename may already have taken away.
		const folders = await Promise.all(
			candidates.map(async (each) => {
				const before = (await store.folderByPath(each))?.remoteId;
				const now = await folderIdAt(each, decided);
				return now !== undefined && now !== before
					? { id: now, placed: true }
					: { id: before, placed: false };
			})
		);
		const moved = candidates.flatMap((candidate, index) => {
			const { id, placed } = folders[index] ?? { id: undefined, placed: false };
			if (id === undefined) return [];
			// One the batch put there has only what comes after to say it lives
			// on, as for `movedNotDeleted`: `A` renamed to `B` carries `A/B` to
			// `B/B`, and its entry at `A/B` is where it was, not where it went.
			const alive = placed
				? listedAfter(live, id, at)
				: aliveElsewhere(live, id, candidate, at);
			if (!alive) return [];
			const last = (live.get(id) ?? []).at(-1);
			return last === undefined ? [] : [{ index, from: candidate, to: last.path }];
		});
		const nearest = moved[0];
		if (nearest === undefined) return undefined;
		if (nearest.index !== 0) return { kind: 'under', from: nearest.from, to: nearest.to };
		// Not if the batch has since put a different folder at the path — `B`
		// renamed to `A`, a new `B` made and deleted — which is what a
		// deletion read in order is about.
		const there = await folderIdAt(path, decided);
		return there === undefined || there === folders[0]?.id ? { kind: 'itself' } : undefined;
	};

	/** The id of the folder at `path` once the decisions so far have run. */
	const folderIdAt = async (
		path: string,
		decided: readonly PullChange[]
	): Promise<string | undefined> => {
		const made = decided.flatMap((change, index) =>
			change.kind === 'ensure-folder' &&
			folderNow(change.path, decided.slice(index + 1)) === path
				? [change.remoteId]
				: []
		);
		if (made.length > 0) return made.at(-1);
		return (await folderAt(path, decided))?.remoteId;
	};

	/**
	 * A folder deleted in a round that goes on to move a subfolder out of it —
	 * `C` deleted after `C/A` was moved to `B`. The deletion cascades over
	 * everything under the folder, clean notes and all, and the entry that says
	 * where the subfolder went finds nothing left to move: the notebook comes
	 * back empty and its notes are gone from this device while the remote
	 * still has them, and only a rescan would bring them back.
	 *
	 * So every subfolder the rest of the round places outside the folder is
	 * decided first, by the last entry about it, and then the folder goes.
	 * Outermost first, and asked again after each: a folder carried out takes
	 * what is in it along. Each entry is decided again in its own turn, which
	 * is a move from wherever the folder is by then — the round's history
	 * replayed.
	 *
	 * Folders only. A note moved out has an entry of its own, which finds the
	 * note the cascade took by its id and puts it back as the same note; one
	 * with unpushed edits the cascade keeps anyway. Decided early and again in
	 * its turn, that edit would be copied aside twice to one name.
	 */
	const deleteFolderAfterRescue = async (
		gone: string,
		{ batch, decided, at }: Step
	): Promise<PullChange[]> => {
		const inside = (folder: SyncFolder, after: readonly PullChange[]): string | undefined => {
			const path = folderNow(folder.path, after);
			return path !== undefined && path !== gone && isWithin(path, gone) ? path : undefined;
		};
		const candidates = [
			...(await store.foldersWithRemote()).flatMap((folder) => {
				const path = inside(folder, decided);
				return path === undefined ? [] : [{ folder, depth: path.length }];
			}),
		].sort((one, two) => one.depth - two.depth);
		const rescued = await candidates.reduce<Promise<PullChange[]>>(
			async (pending, { folder }) => {
				const sofar = await pending;
				const after = [...decided, ...sofar];
				const path = inside(folder, after);
				if (path === undefined) return sofar;
				const leaving = leavesFor(folder.remoteId, gone, batch, at);
				if (leaving !== undefined) {
					const nested = { ...batch, deciding: new Set([...batch.deciding, leaving.at]) };
					return [
						...sofar,
						...(await decide(leaving.entry, {
							batch: nested,
							decided: after,
							at: leaving.at,
						})),
					];
				}
				// Leaving by an entry already being decided further up: two
				// folders deleted, each one's subfolder moved to the other's
				// name. Deciding `D1/S1` onto `D2` rescues `D2/S2` onto `D1`,
				// which has to delete `D1` with `S1` still in it. That entry
				// cannot be decided again from here, so the subfolder is moved
				// out beside the folder instead, and the decision it is part of
				// moves it on from there once the way is clear.
				const stacked = [...batch.deciding].some((index) => {
					const entry = batch.entries[index];
					return (
						entry !== undefined &&
						entry.deleted !== true &&
						entry.remoteId === folder.remoteId &&
						(entry.path === gone || !isWithin(entry.path, gone))
					);
				});
				if (!stacked) return sofar;
				const chosen = after.flatMap((change) =>
					change.kind === 'move-folder' ? [basename(change.to)] : []
				);
				const aside = await freeFolderPath(
					joinPath(parentPath(gone), basename(path)),
					chosen
				);
				return [...sofar, { kind: 'move-folder', from: path, to: aside }];
			},
			Promise.resolve([])
		);
		// Where the folder is after the rescue, which may have moved it aside
		// to make room at its own path for what came out of it. Belt and
		// braces on `undefined`: nothing rescued out of a folder deletes it,
		// and deleting `gone` instead would take whatever the rescue put there.
		const doomedRow = await folderAt(gone, decided);
		const after = [...decided, ...rescued];
		const final = doomedRow === undefined ? gone : folderNow(doomedRow.path, after);
		if (final === undefined) return rescued;
		return [
			...rescued,
			await cascadeOver(
				final,
				doomedRow?.path ?? gone,
				batch.renaming,
				after,
				filesLeaving(final, { batch, decided: after, at })
			),
		];
	};

	/**
	 * The files a folder's deletion must spare (`keepFiles`): bound rows under
	 * it that the rest of the round lists again — out of it, or back in a
	 * folder made again at its name. The batch holds only the last entry about
	 * each file, so a later one is its last word. Each one's own entry puts it
	 * there as the same row, with whatever bytes are held for it; taken by the
	 * cascade, it would come back as a new row with none. Files' answer to the
	 * subfolders rescued above, and to the note a cascade takes that its own
	 * entry puts back by its id.
	 */
	const filesLeaving = (final: string, { batch, decided, at }: Step): string[] =>
		[...filesNow(batch.files, decided).values()].flatMap((file) => {
			if (file.remoteId === undefined || !isWithin(file.at, final)) return [];
			const later = listedAfter(batch.listed, file.remoteId, at);
			return later ? [file.id] : [];
		});

	/**
	 * A different folder of ours sitting where this one is about to land, which
	 * this batch also says is gone — the user deleted `Archive` and renamed
	 * `Archive 2024` onto its name, and both halves arrive together.
	 *
	 * The store keeps one row per path, so the move overwrites that row and
	 * strands its notes under a notebook that now belongs to somebody else. The
	 * deletion, decided afterwards against a path that has changed hands, then
	 * takes the newcomer's notes instead of theirs — both folders' notes gone,
	 * `ok` reported, cursor stored. Deleting it first is the order the remote
	 * did it in, and the store's cascade takes its subfolders with it.
	 *
	 * Deleted only when the batch says so. A folder that is merely in the way is
	 * on its way somewhere else — the user renamed `Archive` to `Older` and
	 * `Archive 2024` to `Archive`, two drags, one window — and the entry saying
	 * where may come later. That one is moved aside instead, exactly as a note
	 * in the same position is, and the entry that says where it went moves it on
	 * from there. Deleting it on suspicion would take notes nobody asked to
	 * lose; leaving it merges both folders' notes into one notebook and loses a
	 * row, which is how `Archive/old.md` ends up inside `Older`.
	 */
	const freeFolderPath = (path: string, taken: readonly string[]): Promise<string> =>
		// Bounded, because the loop's termination rests on `conflictFolderName`
		// recognising the name it just produced when that name is handed back in
		// `taken`. Those are two folds — the one that writes the name and the one
		// that reads it — and if they ever disagree, `n` stops advancing and this
		// recurses for ever. That is not a wrong name: it is `pull()` never
		// returning, with no error, no cursor movement and no way for the user to
		// tell. Running out of attempts throws instead, which stops the batch and
		// leaves the cursor where it was, so the next sync retries the same work.
		//
		// The drift is untestable by construction, and the cap is kept anyway: a
		// test that produced the drift would be asserting about a build of the
		// code nobody ships. (A hundred names really taken reach the cap too, and
		// that is tested for notes, through `freeNotePath` in
		// `push/conflicts.ts`.) It was found the way such things are — a
		// mutation of `conflictName`'s fold did not fail the suite, it hung it.
		findFreeName<string>({
			candidate: (names) => conflictFolderPath(path, now(), names),
			claim: async (candidate) =>
				(await store.folderByPath(candidate)) === undefined
					? { free: candidate }
					: { taken: candidate },
			attempts: FREE_PATH_ATTEMPTS,
			exhausted: () => new Error(`could not find a free folder path beside ${path}`),
			taken,
		});

	/**
	 * Which folder row is at `path` once the decisions so far have run: the one
	 * at the path it came from (`folderBefore`), since the store can only be
	 * asked about the paths it already holds — the same reason `notesEndingIn`
	 * exists on the note side.
	 */
	const folderAt = async (
		path: string,
		decided: readonly PullChange[]
	): Promise<SyncFolder | undefined> => {
		const origin = folderBefore(path, decided);
		return origin === undefined ? undefined : store.folderByPath(origin);
	};

	/**
	 * The folder a deletion is about, and where it stands once everything in
	 * front of this decision has been applied — or `undefined` if it is not one
	 * we hold, or is already gone.
	 *
	 * Both halves have to be asked of the batch rather than the store, and they
	 * are different questions. *Which* folder needs the id where there is one:
	 * two drags in a window (delete `A`, rename `B` onto `A`, delete `A` again)
	 * name one path and mean two different folders, and answering by path deletes
	 * the newcomer the first time and nothing at all the second. *Where* it is
	 * needs the batch: a rename in front of this decision has already moved it,
	 * and a `delete-folder` naming the path it used to be at removes whatever
	 * took its place.
	 */
	const doomedFolder = async (
		path: string | undefined,
		remoteId: string | undefined,
		{ batch, decided, at }: Step
	): Promise<string | undefined> => {
		// Made inside this cursor window, so there is no row to find it by: a
		// folder created and removed between two cursors is reported as both,
		// and asking the store alone leaves a notebook in the sidebar with
		// nothing behind it until the next cursor reset. Tracked forwards from
		// the point it was made, so one a later change has moved or taken away
		// answers with where it ended up. With no id, the path is where the
		// deletion found it — made at `A` and renamed to `B` before `B` was
		// deleted — so it is matched by where it is now, not where it was made.
		const made = decided.flatMap((change, at) => {
			if (change.kind !== 'ensure-folder') return [];
			const now = folderNow(change.path, decided.slice(at + 1));
			const same = remoteId === undefined ? now === path : change.remoteId === remoteId;
			return same ? [now] : [];
		});
		if (made.length > 0) return made[made.length - 1];

		if (remoteId !== undefined) {
			const mine = await store.folderByRemoteId(remoteId);
			return mine === undefined ? undefined : folderNow(mine.path, decided);
		}

		// No id — Dropbox's `DeletedMetadata` is a path and nothing else — so
		// the path is the only thing it can be matched by, and the folder that
		// was there when the batch started is what it means. Once that one has
		// moved on or been taken away, whatever is at the path now arrived
		// after the deletion was recorded and is not what it is about.
		if (path === undefined) return undefined;
		const before = await store.folderByPath(path);
		// A row the remote has never heard of is not what a deletion is about,
		// and nothing else can be either: whatever the batch has put at the
		// path arrived after this, and this row is in its way, not in the
		// deletion's. This device removing a notebook and the user making
		// another at the same name is the everyday way to get there — our own
		// deletion comes back to us as a path and nothing else (Dropbox), and
		// taken for the new notebook it deletes the row the user has just made
		// and cascades over what they have put in it, while the `mkdir` queued
		// behind it makes the directory again.
		if (before !== undefined && before.remoteId === undefined) return undefined;
		// Unless the batch has already said so once. A second deletion of the
		// path is not about the folder the first one took — a round read whole
		// carries `C` deleted, `A` renamed to `C`, and `C` deleted again — and
		// can only be about whatever the batch has put there since.
		const again = batch.entries.some(
			(entry, index) =>
				index < at &&
				entry.deleted === true &&
				entry.remoteId === undefined &&
				entry.path === path
		);
		if (before !== undefined && !again) {
			return folderNow(path, decided) === path ? path : undefined;
		}

		// Nothing there before, or taken already, so the only way a deletion
		// can be about something is if the batch has since moved a folder onto
		// the path.
		return (await folderAt(path, decided)) === undefined ? undefined : path;
	};

	const clearTheWay = async (
		to: string,
		remoteId: string,
		{ batch, decided, at }: Step,
		from?: string
	): Promise<PullChange[]> => {
		const { doomed } = batch;
		const occupant = await folderAt(to, decided);
		// Belt and braces on the second half: our own folder cannot be the thing
		// in our way, because we only got here with `folderNow` saying it is
		// somewhere else. `folderNow` walks the batch forwards and `folderAt`
		// walks it backwards, though, and a disagreement between them would
		// otherwise have this folder displace itself and then move from a path
		// it has just left.
		if (occupant === undefined || occupant.remoteId === remoteId) return [];

		const named =
			doomed.paths.has(occupant.path) ||
			(occupant.remoteId !== undefined && doomed.ids.has(occupant.remoteId));
		// Deleted, unless the folder arriving is inside it — `C/A` moved up to
		// `C` as `C` goes — when the cascade would take the arrival with it.
		// Then it is moved aside like any other, and the deletion that names
		// it finds it there. And deleted as any other deletion is, after what
		// the round moves out of it: `B/sub` moved to `Keep`, `B` deleted and a
		// new `B` made, reported new `B` first as an id-tree page puts folders.
		const inside = from !== undefined && isWithin(from, to);
		if (named && !inside) return deleteFolderAfterRescue(to, { batch, decided, at });

		// Names this batch has already put a folder at, so two folders displaced
		// out of one path do not both take the same one.
		const chosen = decided.flatMap((change) =>
			change.kind === 'move-folder' ? [basename(change.to)] : []
		);
		return [{ kind: 'move-folder', from: to, to: await freeFolderPath(to, chosen) }];
	};

	/**
	 * A folder move drops everything under it onto the destination, and the
	 * destination is not necessarily empty. `clearTheWay` above answers for the
	 * *folder* in the way; this answers for the notes.
	 *
	 * They are not the same question, and the second survives the first being
	 * answered: a folder deleted earlier in this batch leaves its dirty notes
	 * behind at their paths — that is what the cascade does, because an unsaved
	 * edit outranks a remote deletion — so there is no folder in the way and
	 * still something at the path. Moving onto them puts two rows at one path.
	 * The store has no way to tell them apart afterwards, and a push then sends
	 * both to the same remote file, each overwriting the other for ever.
	 *
	 * The local note moves aside rather than the arriving one, for the same
	 * reason as every other displacement here: the remote keeps the path
	 * (CLAUDE.md), and the edit the user has not pushed keeps its bytes.
	 */
	const clearTheNotes = async (
		from: string,
		to: string,
		{ batch, decided, at }: Step
	): Promise<PullChange[]> => {
		const movers = await notesUnderNow(from, decided);
		const landing = new Map(
			movers.map((entry) => [rebasePath(entry.path, from, to), entry.note])
		);
		// Said later in this batch to be somewhere other than `path`: the clash
		// is not where it ends up, and the entry that says so moves it on. A
		// page reports `b.md` arriving at `A/c.md` ahead of `C` becoming `A`,
		// whose `c.md` is renamed to `a.md`; displacing the note already there
		// leaves a conflict copy of a note that never conflicted. Asked of the
		// note arriving only: the one sitting there got there by its own entry,
		// which is the last word about it, or was never in the batch at all.
		const movesOn = (note: SyncNote, path: string): boolean => {
			const remoteId = remoteNow(note, decided);
			return remoteId !== undefined && listedAfter(batch.live, remoteId, at, path);
		};
		const sitting = await notesUnderNow(to, decided);
		return sitting.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const moves = await pending;
			const arriving = landing.get(entry.path);
			if (arriving !== undefined && movesOn(arriving, entry.path)) {
				return moves;
			}
			const mover = arriving?.id;
			// Nothing is landing on it. The second half is belt and braces: a
			// note cannot be both the thing arriving and the thing in the way
			// unless `rebasePath` returns the path it was given, which needs
			// `from` and `to` to be equal — and `decideFolder` only gets here
			// with `folderNow` saying they are not. Displacing a note against
			// itself would rename it to a conflict copy over a move that did
			// nothing to it at all, so the check stays.
			if (mover === undefined || mover === entry.note.id) return moves;
			// Threaded through, so two notes displaced out of one folder do not
			// both take the same name.
			const taken = await takenIn(parentPath(entry.path), batch.claimed, [
				...decided,
				...moves,
			]);
			return [
				...moves,
				{
					kind: 'displace-note',
					id: entry.note.id,
					path: conflictPath(entry.path, now(), taken),
				},
			];
		}, Promise.resolve([]));
	};

	/**
	 * A folder arriving for the first time at a path another folder of ours is
	 * still at, which this batch goes on to move somewhere else or delete —
	 * `B` moved into a new `B` as `B/C`, both halves in one round. Merged, the
	 * newcomer takes the row, the move that follows carries it off with the
	 * other's notes, and the new `B` is gone from here. So the one in the way is
	 * got out of it first, as for a folder moving onto the path, and the entry
	 * that says where it went moves it on from there.
	 *
	 * Only then. A folder with no id is one the user made here, whose `mkdir`
	 * the arriving one answers; and one the batch says nothing more about has no
	 * other place to go to, so the two stay one notebook as before.
	 */
	const roomForNewFolder = async (
		entry: RemoteEntry,
		{ batch, decided, at }: Step
	): Promise<PullChange[]> => {
		const occupant = await folderAt(entry.path, decided);
		const id = occupant?.remoteId;
		if (id === undefined || id === entry.remoteId) return [];
		const movesOn = listedAfter(batch.live, id, at, entry.path);
		if (!movesOn && !batch.doomed.ids.has(id)) return [];
		return clearTheWay(entry.path, entry.remoteId, { batch, decided, at });
	};

	const decideFolder = async (
		entry: RemoteEntry,
		{ batch, decided, at }: Step
	): Promise<PullChange[]> => {
		// The app folder itself, which several providers report as an entry of
		// its own — Graph's `delta` returns the root item. There is nothing above
		// it to hold a row, and a row for it would be reconciled away after the
		// next cursor reset as a folder the scan did not mention. Since every
		// path is within the root, that one `delete-folder` means every note on
		// the device. The root is not a notebook, so it is not a folder row.
		if (normalizePath(entry.path) === ROOT) return [];

		// A notebook the user has removed here, whose `rmdir` is still queued.
		// This is that push's own `mkdir` coming back — a sync pulls before it
		// pushes, so a notebook deleted between the two rounds is reported as a
		// folder that exists — and making the row again puts the notebook back
		// in the sidebar and stops the `rmdir`, which refuses to remove a
		// directory the device still holds. The queue is what says the user has
		// let it go; a folder the user made again withdrew the `rmdir`
		// (`store/queue.ts`), and one another device makes at the name has an id
		// of its own.
		//
		// At that path only. Another device may have moved the folder since —
		// and the `rmdir` then finds something else at the name and leaves it
		// alone — so the notebook is still there to be had, under its new name,
		// and dropping it would take it from this device for good.
		if (batch.removing.get(entry.remoteId) === entry.path) return [];

		const made = decided.flatMap((change, index) =>
			change.kind === 'ensure-folder' && change.remoteId === entry.remoteId ? [index] : []
		);
		const existing = await store.folderByRemoteId(entry.remoteId);
		// Where that folder is *now*, not where the store last saw it. A rename
		// of `A` and a move of `A/sub` out of it land in one batch all the time
		// — one drag after another — and the second decision is reached after
		// the first has already rebased everything under `A`. Naming the old
		// path moves nothing at all, silently, and the notebook keeps a position
		// the remote abandoned for as long as the cursor lives. One this batch
		// made is followed from where it was made.
		const whereAfter = (after: readonly PullChange[]): string | undefined => {
			const last = made.at(-1);
			if (last !== undefined) {
				const change = after[last];
				return change?.kind === 'ensure-folder'
					? folderNow(change.path, after.slice(last + 1))
					: undefined;
			}
			return existing === undefined ? undefined : folderNow(existing.path, after);
		};
		const from = whereAfter(decided);
		if (from !== undefined && from !== entry.path) {
			// In this order: the folder first, because getting it out of the way
			// takes the notes inside it with it and leaves nothing to displace.
			const room = await clearTheWay(
				entry.path,
				entry.remoteId,
				{ batch, decided, at },
				from
			);
			// And asked again after it, since the folder in the way may be the
			// one this is moving out of — `Z/X` moved up to `B` while `B` is
			// renamed to `Z` — and has carried this one aside with it. Never
			// deleted with it: `clearTheWay` moves a folder this one is inside.
			const moved = whereAfter([...decided, ...room]) ?? from;
			const spare = await clearTheNotes(moved, entry.path, {
				batch,
				decided: [...decided, ...room],
				at,
			});
			return [
				...room,
				...spare,
				{ kind: 'move-folder', from: moved, to: entry.path, remoteId: entry.remoteId },
			];
		}
		const room =
			from === undefined ? await roomForNewFolder(entry, { batch, decided, at }) : [];
		return [...room, { kind: 'ensure-folder', path: entry.path, remoteId: entry.remoteId }];
	};

	return { movedFolderOver, folderIdAt, deleteFolderAfterRescue, doomedFolder, decideFolder };
};

/** What the pull's other parts are handed of it. */
export type PullFolders = ReturnType<typeof createPullFolders>;
