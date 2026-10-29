import { contentHash } from '../../hash.js';
import { parseNoteFile } from '../../markdown/note.js';
import { conflictPath } from '../../names/conflicts.js';
import { parentPath } from '../../paths.js';
import {
	type EntryRef,
	isNotFoundError,
	isUnreadableError,
	type RemoteEntry,
} from '../../providers/types.js';
import { conflictContent } from '../conflicts.js';
import type { EngineContext } from '../context.js';
import type { ConflictResolution, PullChange, SyncNote } from '../store.js';
import { madeInBatch, type Step } from './batch.js';
import { reestablished } from './decided.js';
import { forgetUnread } from './deletions.js';
import type { Occupancy } from './occupancy.js';
import { type Placement, remoteNow, removedInBatch, unreadNow, whereNow } from './replay.js';

/**
 * The notes, as a pull decides them: a listed note matched to the row it is
 * (`noteForEntry`) or given an id (`idForNewNote`), read and reconciled with
 * an edit here by the conflict rule (`decideFile`, `decideKnown`), the note in
 * its way moved aside (`displaceOccupant`), and what a note the remote no
 * longer has becomes (`forgetNote`, `keepNote`, `noteNoLonger`). Moved out of
 * `engine.ts` as they were (#446).
 */

export const createPullNotes = (
	context: EngineContext,
	{
		readNote,
		notesEndingIn,
		takenIn,
	}: {
		readNote: (entry: RemoteEntry) => Promise<{ content: string; version: string }>;
	} & Pick<Occupancy, 'notesEndingIn' | 'takenIn'>
) => {
	const { provider, store, now, newId, meter } = context;

	const resolutionFor = async (
		local: SyncNote,
		remoteContent: string,
		remote: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	): Promise<ConflictResolution> => {
		const copyId = newId();
		// Beside where the note ends up, not where it was. The two are the same
		// for an ordinary conflict, and differ when the note was moved and
		// edited between syncs — and there the old folder may be one this very
		// batch is deleting, so a copy left behind in it either resurrects a
		// folder the user removed or lands somewhere the sidebar never shows.
		const taken = await takenIn(parentPath(remote.path), claimed, decided);
		return {
			noteId: local.id,
			remoteContent,
			remoteHash: await contentHash(remoteContent),
			remote,
			copyId,
			copyPath: conflictPath(remote.path, now(), taken),
			copyContent: conflictContent(local.content, copyId),
		};
	};

	/**
	 * What a read says about a file, for the callers that ask whether it exists
	 * rather than what it holds. Only "not found" is `gone`. A file that is not
	 * UTF-8 text is there — that is the one thing an `UnreadableError` is sure
	 * of — and a probe that took it for missing would have a note re-created
	 * beside its own file, or a rename dropped. Anything else is the provider
	 * failing to say, and is the caller's failure too.
	 */
	const fileState = (ref: EntryRef): Promise<'there' | 'gone' | 'unreadable'> =>
		provider.read(ref).then(
			() => 'there' as const,
			(error: unknown) => {
				if (isNotFoundError(error)) return 'gone' as const;
				if (isUnreadableError(error)) return 'unreadable' as const;
				throw error;
			}
		);

	/**
	 * Whether a note's file is there now, asked of the provider by id, for the
	 * few decisions a feed cannot settle. Only "not found" says no: with no file
	 * to ask about the answer is yes, and a read that fails for any other reason
	 * fails the pull, which is tried again. A whole read, since the port has no
	 * cheaper question; these cases are rare.
	 *
	 * A file that has become unreadable is there. The note stays bound to it
	 * only until the file's own entry arrives, which it must, since its bytes
	 * changed; `decideFile` lets go of the note then.
	 */
	const stillThere = async ({
		at,
		remoteId,
	}: Pick<Placement, 'at' | 'remoteId'>): Promise<boolean> => {
		if (at === undefined || remoteId === undefined) return true;
		return (await fileState({ path: at, remoteId })) !== 'gone';
	};

	/**
	 * The note an entry is about. `remoteId` is the identity; the path is the
	 * fallback, and it is what lets a note created here be recognised when its
	 * own first push arrives back, and a file deleted and re-created at the same
	 * path stay one note rather than becoming two rows the sidebar shows twice.
	 *
	 * The one case the fallback must not take is a note whose own remote copy is
	 * alive elsewhere in this batch: that note has been moved away and the path
	 * merely reused, so claiming it here would point it at somebody else's file
	 * and hand them each other's contents.
	 *
	 * Nor a note the batch has already moved off the path, which is the same
	 * mistake reached the other way round. A folder rename in front of this
	 * decision takes every note under it along, and nothing in the feed says so
	 * about each file — one entry for the folder is the whole report. The store
	 * still has the note sitting at its old path, so a *different* file arriving
	 * there is matched to it, and the note is written over with somebody else's
	 * bytes while its own file goes on existing under the new name.
	 *
	 * Nor, below: a note the user has deleted here, one they have renamed onto
	 * the path, or one whose own file is still there.
	 */
	const noteForEntry = async (
		entry: RemoteEntry,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): Promise<SyncNote | undefined> => {
		const byId = await store.noteByRemoteId(entry.remoteId);
		if (byId !== undefined) return byId;

		const byPath = await store.noteByPath(entry.path);
		if (byPath === undefined) return undefined;
		// Moved elsewhere, not merely taken away: a note the batch has already
		// removed has nothing of its own left and becomes this file, which is
		// what `removed` in `decideFile` is for.
		const at = whereNow(byPath, decided);
		if (at !== undefined && at !== entry.path) return undefined;
		const own = byPath.remoteId;
		if (own !== undefined && batch.live.has(own)) return undefined;
		// Nor a note the user has deleted, wherever it stands. Its file went on
		// another device too, and this is a new one there that took the name:
		// brought back as that note, it is still deleted here, and its queued
		// delete removes the other device's note from the remote. A feed reports
		// the old file gone first, so the batch has removed the note by now; a
		// scan never says what was removed, so the note is still at the path —
		// and claimed below, as a file replaced while the cursor was dead.
		if (batch.deleting.has(byPath.id)) return undefined;
		if (at === undefined) return byPath;
		// The user's own rename, not yet pushed: the note is at this path because
		// they put it here, and its file is still wherever it was. Claimed, it
		// takes the arriving file's bytes and forgets its own — which the feed
		// has no reason ever to mention again — and the queued move then goes
		// nowhere. It is in the way instead, and moves aside.
		if (batch.renaming.has(byPath.id)) return undefined;
		if (own === undefined) return byPath;
		// A scan says what exists and never what was removed, so a file replaced
		// at this path while the cursor was dead arrives with nothing about the
		// old one, and the path is the only thing tying them together. A feed
		// usually says so, and then the note becomes the file that replaced its
		// own. When it does not — a provider need not report the deletion of a
		// file replaced at its path — the provider is asked. Still there, it is
		// unmentioned because unchanged, and this is a different file that has
		// taken the name; claimed, the note forgets its own for ever.
		if (batch.scanning || batch.doomed.ids.has(own) || batch.doomed.paths.has(entry.path)) {
			return byPath;
		}
		return (await stillThere({ at: byPath.path, remoteId: own })) ? undefined : byPath;
	};

	/** A note that vanished remotely: gone if we have no edits, kept if we do. */
	const forgetNote = (local: SyncNote): PullChange =>
		local.dirty ? { kind: 'detach-note', id: local.id } : { kind: 'delete-note', id: local.id };

	/**
	 * The same note, when the scan that failed to mention it was one the provider
	 * warned us about (`uploadDifferences`): its own copy may be what lost the
	 * file, so the note goes back up instead of away. A dirty note already takes
	 * that path — `detach-note` forgets the remote and its write re-creates the
	 * file — so only the clean ones need saying differently.
	 */
	const keepNote = (local: SyncNote): PullChange =>
		local.dirty
			? { kind: 'detach-note', id: local.id }
			: { kind: 'reupload-note', id: local.id };

	/**
	 * What to call a note arriving for the first time. A file this app wrote
	 * carries its `id` in frontmatter (docs/ARCHITECTURE.md §3), and adopting it is what
	 * makes two devices agree about which note a file is; a file written by
	 * something else needs an id invented for it.
	 *
	 * Unless the id is already spoken for. Duplicating a file is an ordinary
	 * thing to do in a folder the user can see, and the copy carries the
	 * original's id — so adopting it blindly would write the copy over the note
	 * it came from, unpushed edits included, and leave the two files fighting
	 * over one row on every sync afterwards. Two files claiming one id is the
	 * state the whole scheme is built to avoid; the second one to arrive is a
	 * new note.
	 */
	const idForNewNote = async (
		content: string,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): Promise<string> => {
		const claimed = parseNoteFile(content).id;
		if (claimed === undefined) return newId();

		// Nor an id the user has a delete queued for. The op names its note by
		// id and nothing else, so a row made under that id *is* its target,
		// whatever file the row holds — and a queued delete can outlive its row.
		// A tombstone whose file became unreadable is let go of with its delete
		// still queued (`leaveUnread`), and the other device's edit to that same
		// note is set aside in a file that carries this id; adopted, that copy is
		// what the delete removes. `noteForEntry` refuses the same note by path,
		// for the same reason.
		//
		// Asked of the queue rather than settled by withdrawing the op when the
		// row goes: the queue is read for every batch, so this holds for a copy
		// arriving in this batch or in any later one, for as long as the op is
		// there — and once a push has run it, with no row, it is done and sends
		// nothing. Withdrawing would need the store to be told, and would leave
		// this door open to every other way a delete comes to outlive its row.
		if (batch.deleting.has(claimed)) return newId();

		// Held by a note that is still going to be there. One this batch has
		// already taken away is not a competing claim — a file moved in a way the
		// provider reports as a delete plus a create is one note, and the id in
		// the file is the only thing tying the two halves together.
		const holder = await store.noteById(claimed);
		const held = holder !== undefined && !removedInBatch(holder, decided);
		if (held || reestablished(decided).notes.has(claimed)) return newId();
		// Another connection on the device may hold a note of this id too — the
		// same folder in two accounts is enough. It is not asked about: an id
		// names a note within its connection, and a store keys its rows that
		// way, so the two never meet.
		return claimed;
	};

	/** A note we already hold, whose remote version has moved. */
	const decideKnown = async (
		local: SyncNote,
		found: Readonly<{ content: string; version: string }>,
		entry: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[],
		renaming: ReadonlyMap<string, string>
	): Promise<PullChange[]> => {
		const { content } = found;
		const syncedHash = await contentHash(content);
		// Where the batch has the note by now, not the row's own path: a folder
		// rename decided in front of this carries the note off without a word
		// about the file, and a file then moved back onto the old name reads as
		// one that never left — the note stays under the folder's new name over
		// a file that is not there, and its next write blocks the queue.
		const unchanged = (): PullChange[] =>
			whereNow(local, decided) === entry.path || renaming.has(local.id)
				? [{ kind: 'adopt-version', id: local.id, remote: entry, syncedHash }]
				: [
						{
							kind: 'move-note',
							id: local.id,
							path: entry.path,
							remote: entry,
							syncedHash,
						},
					];

		// Same bytes, new version: our own write coming back, two devices that
		// saved the same thing, or a move on a provider whose version does not
		// survive one — Dropbox's `rev` does, OneDrive's `eTag` does not.
		//
		// Adopting the version matters either way: leaving the old one would make
		// the next push send an `expectedVersion` the remote has moved past, and
		// manufacture a conflict over a file that already agrees.
		//
		// A different path is a rename — but whose? The feed cannot say, and the
		// queue is the only thing that can: a `move` queued for this note is the
		// user's own rename, not yet pushed, and the entry is our own echo from
		// before it. Moving the row back undoes what the user just did in front
		// of them, and worse, frees the path they renamed *to* — so a file
		// arriving there in the same batch is imported rather than displaced,
		// the queued move then conflicts on that path for ever, and the ordered
		// queue strands every op behind it. The version is still adopted; only
		// the path is left where the user put it. This is `followTheRename`'s
		// question, asked from the pull side.
		if (content === local.content) return unchanged();
		if (!local.dirty) {
			return [
				{
					kind: 'upsert-note',
					id: local.id,
					path: entry.path,
					content,
					remote: entry,
					syncedHash,
				},
			];
		}
		// Different bytes from ours, but ours hold edits the remote has not seen —
		// so the question is whether the *remote* changed, and the bytes this
		// note last synced answer it. The same bytes under a new version is a
		// rename, or a move, on a provider whose version does not survive one
		// (OneDrive's `eTag`): nothing was written over there, the local edits
		// stay dirty and go out against the new version, and there is no copy
		// for the user to wonder about (docs/ARCHITECTURE.md §7). A note that has not
		// recorded its bytes cannot say, and takes the conflict as before.
		//
		// Only if the bytes are the version the feed named, though: this is the
		// one branch that lets a push overwrite the remote on the strength of a
		// read, and a read that answers with an older version (a cache, or a
		// file written again since) would adopt a version whose bytes nobody
		// looked at — and the push would replace them without a copy.
		if (found.version === entry.version && local.syncedHash === syncedHash) return unchanged();
		const resolution = await resolutionFor(local, content, entry, claimed, decided);
		return [{ kind: 'conflict', resolution }];
	};

	/**
	 * A note of ours sitting where a remote one is about to land. Two devices
	 * both writing an `Untitled.md` offline is the ordinary way to get there,
	 * and so is a note moved remotely into a folder where we happen to have one
	 * of the same name.
	 *
	 * The remote keeps the path, per §7, and ours moves aside under the name a
	 * conflict copy would get — because that is what this is. Left where it was,
	 * the two share a path: the sidebar shows one row twice, the queued write
	 * for ours eventually lands on the other one's file, and both rows end up
	 * carrying one `remoteId`, after which `noteByRemoteId` only ever hands back
	 * one of them and the other is stale for ever.
	 *
	 * Ours moves whether or not it has been pushed. A note that has been pushed
	 * has no claim to this path either — the remote has something else here, so
	 * that note's own file is elsewhere or gone, and the entry saying which will
	 * move it home. Its queued write does not reach the new name meanwhile:
	 * `runWrite` finds nothing at that path and checks by `remoteId` before
	 * creating anything.
	 */
	const displaceOccupant = async (
		path: string,
		keeper: string | undefined,
		decided: readonly PullChange[],
		claimed: ReadonlySet<string>
	): Promise<PullChange[]> => {
		// Asked of the batch, not the store: a note that is there now may have
		// been moved on or taken away by an earlier decision, and one that is
		// not may be about to be carried in by a folder move. Asking the store
		// to move a note that is not there fails the batch — and a batch the
		// store rejects is retried for ever, because the cursor moves only with
		// it. More than one can land here, since a folder move can bring a note
		// down on top of one already in place.
		const occupants = (await notesEndingIn(parentPath(path), decided)).filter(
			(entry) => entry.path === path && entry.note.id !== keeper
		);
		return occupants.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const moves = await pending;
			// Threaded through, so the second of them does not take the name the
			// first has just been given.
			const taken = await takenIn(parentPath(path), claimed, [...decided, ...moves]);
			return [
				...moves,
				{
					kind: 'displace-note',
					id: entry.note.id,
					path: conflictPath(path, now(), taken),
				},
			];
		}, Promise.resolve([]));
	};

	/**
	 * Nothing to do for a file gone by the time it is read (see `decideFile`),
	 * except for a note held by that very file and about to follow it to a new
	 * path. The deletion arriving behind the entry — in this batch or a later
	 * one — is at that new path, where the note never got to, and one with no
	 * id, which is all Dropbox's `DeletedMetadata` is, has nothing else to find
	 * the note by. The file named by its id is gone, so the note is let go of
	 * here. At its own path the deletion finds it, and nothing is decided on a
	 * read alone.
	 */
	const goneBeforeRead = (
		local: SyncNote | undefined,
		entry: RemoteEntry,
		decided: readonly PullChange[]
	): PullChange[] => {
		if (local === undefined || local.remoteId !== entry.remoteId) return [];
		// Its own path is where the batch has carried it, as in `decideFile`.
		const at = whereNow(local, decided);
		return at === undefined || at === entry.path ? [] : [forgetNote(local)];
	};

	/**
	 * A file that is there and is not UTF-8 text (`UnreadableError`). Nothing is
	 * imported, and nothing of ours may go on pointing at it: a row bound to a
	 * file holds that file's version, so its next push passes the version check
	 * and replaces bytes this device never read with text it made up — even a
	 * push that only adds an `id`. So **no row holds the id of a file the engine
	 * could not read** (docs/ARCHITECTURE.md §7), and nothing this decision leaves
	 * behind can write, move or delete the file. That is a promise about the
	 * pull, from the moment it sees the file. A delete already queued and pushed
	 * before any pull has seen the re-save still removes it, as it would an
	 * edit made on another device: `runDelete` asks nothing of the file.
	 *
	 * A note bound to a file is let go of as one whose file has vanished:
	 * clean, it goes from this device and nothing is queued against the remote;
	 * dirty, it is cut loose and keeps its edit. A tombstone is clean, and goes:
	 * its delete was of text the user saw, not of these bytes. The op stays
	 * queued until a push finds no note for it, which is why `idForNewNote`
	 * will not hand its id to a file arriving meanwhile. That covers the note this file
	 * was, and one matched by path whose own file is another that has gone.
	 *
	 * Then whatever of ours is still at the path moves aside, as for any file
	 * arriving there: the dirty note just cut loose, or a note never pushed that
	 * has the same name. Its write then creates a new file beside the one that
	 * could not be read. A file we cannot read is nobody's first push coming
	 * back, so there is no claiming it (`isStranger`). A dirty note the user has
	 * renamed is not at the path, and stays where they put it.
	 *
	 * Never a throw. A pull that throws does not move its cursor, the next one
	 * fetches the same entry and reads the same bytes, and one Latin-1 file has
	 * stopped the user's sync for good.
	 *
	 * And it is said (`UnreadableFile`): a clean note that goes this way leaves
	 * the device without a word otherwise. Only when there is something new to
	 * say. With no row to hold its version the file is read on every mention,
	 * and a record for each would have `pulled` count a change every time the
	 * feed named the file again. So: a file not yet listed, one listed at
	 * another path (renamed, and still unreadable), or one that has just moved
	 * a note of the user's aside — every one of them, since a folder move can
	 * land two rows on one name before this is reached, and kept on the record
	 * when the file is listed again elsewhere, because those notes are still
	 * where they were put. Any other file listed at this path is not at it any
	 * more: a tool that saves by deleting and writing again gives the file a
	 * new id, and not every feed mentions the old one going.
	 */
	const leaveUnread = async (
		local: SyncNote | undefined,
		removed: boolean,
		entry: RemoteEntry,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): Promise<PullChange[]> => {
		const letGo =
			local !== undefined && !removed && local.remoteId !== undefined
				? [forgetNote(local)]
				: [];
		const aside = await displaceOccupant(
			entry.path,
			undefined,
			[...decided, ...letGo],
			batch.claimed
		);
		const replaced = forgetUnread(
			{ batch, decided },
			(remoteId, path) => path === entry.path && remoteId !== entry.remoteId
		);
		const already = unreadNow(batch.unread, decided).get(entry.remoteId);
		const kept = already?.movedAside ?? [];
		const displaced = aside.flatMap((change) =>
			change.kind === 'displace-note' && !kept.includes(change.path) ? [change.path] : []
		);
		if (already?.path === entry.path && displaced.length === 0) return [...letGo, ...aside];
		const movedAside = [...kept, ...displaced];
		const record: PullChange = {
			kind: 'unreadable',
			file: {
				remoteId: entry.remoteId,
				path: entry.path,
				...(movedAside.length === 0 ? {} : { movedAside }),
			},
		};
		return [...letGo, ...aside, ...replaced, record];
	};

	/**
	 * A file that reads, at this path and under this id, is not an unreadable
	 * one: whatever is listed under either stops being. The id is the file
	 * fixed in place. The path is the file fixed by a tool that saves by
	 * writing a new one over the old name — a new id, and on some feeds no word
	 * of the old one going.
	 */
	const forgetRead = (
		entry: RemoteEntry,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): PullChange[] =>
		forgetUnread(
			{ batch, decided },
			(remoteId, path) => remoteId === entry.remoteId || path === entry.path
		);

	/**
	 * A note never pushed has no file to be matched by, only a path, and the
	 * path proves nothing about whose file this is. It is ours when it is our
	 * own first push coming back — the write landed and the tab closed before
	 * the store heard — which the bytes, or the id they carry, show. Anything
	 * else is another device's note that took the same name. A dirty one is
	 * safe to claim: it conflicts, and its edit goes to a copy. A clean one is
	 * not — it is written over — and nor is a note the user deleted before it
	 * was ever pushed, which the store reports clean: claimed, its queued delete
	 * has a file to aim at, and removes the other device's note.
	 */
	const isStranger = (local: SyncNote, content: string): boolean =>
		!local.dirty &&
		local.remoteId === undefined &&
		content !== local.content &&
		parseNoteFile(content).id !== local.id;

	const decideFile = async (
		entry: RemoteEntry,
		{ batch, decided }: Pick<Step, 'batch' | 'decided'>
	): Promise<PullChange[]> => {
		const { claimed, renaming } = batch;
		const local = await noteForEntry(entry, { batch, decided });
		// Taken away by an earlier decision in this batch — the file was deleted
		// and re-created at the same path, or moved out of a folder that went.
		// Everything below that needs the row to still be there is off the table;
		// what is left is to write it back, under the id it already had, so the
		// user keeps one note rather than watching one vanish and another appear.
		const removed = local !== undefined && removedInBatch(local, decided);
		// For every way out of here but the two where the file was not read. A
		// version this device already holds is a file it has read.
		const cleared = forgetRead(entry, { batch, decided });

		// Whatever we decide below puts a note at `entry.path`, so anything of
		// ours already there has to move first — in that order, or the store is
		// asked to hold two notes at one path with no way to tell them apart.
		const room = await displaceOccupant(entry.path, local?.id, decided, claimed);
		const after = [...decided, ...room];

		// The version we already hold. Either nothing happened, or the file was
		// renamed — a rename alone changes no bytes, so there is nothing to read.
		if (local !== undefined && !removed && local.remoteVersion === entry.version) {
			// Asked of the batch, as everything here is. A folder rename in front
			// of this entry has carried the note away, and the store still shows
			// it at its old path — which is exactly where a file moved back onto
			// that name says it is. Read off the row, that is "nothing happened",
			// and the note ends up under the folder's new name with its file here.
			if (whereNow(local, decided) === entry.path) return cleared;
			// The file's bytes have not moved either, so the hash the note holds
			// still describes them. Passed rather than left to the store to keep,
			// because a `detach-note` or deleted folder earlier in this batch has
			// already dropped it from the row this re-binds.
			const kept = local.syncedHash === undefined ? {} : { syncedHash: local.syncedHash };
			if (renaming.has(local.id)) {
				return [
					...cleared,
					...room,
					{ kind: 'adopt-version', id: local.id, remote: entry, ...kept },
				];
			}
			return [
				...cleared,
				...room,
				{ kind: 'move-note', id: local.id, path: entry.path, remote: entry, ...kept },
			];
		}

		// `changes` and `read` are separate round trips on every provider, so the
		// file the feed named can be deleted in between. Throwing here unwinds
		// the whole pull, and since the cursor moves only with the batch, the
		// next attempt fetches the same batch and dies the same way — for ever,
		// taking push with it, because `sync` stops when a pull is not `ok`.
		// There is nothing to import and nothing of ours to move aside; the
		// deletion arrives as an entry of its own, here or in a later batch.
		//
		// Nor may a file that is not UTF-8 text throw, for the same reason and
		// worse: that one reads the same way every time (`leaveUnread`).
		//
		// Read once per version: a pull that failed after reading it read it into
		// `held`, and this is that pull again.
		const found = await readNote(entry).catch((error: unknown) => {
			if (isNotFoundError(error)) return 'gone' as const;
			if (isUnreadableError(error)) return 'unreadable' as const;
			throw error;
		});
		meter.scanRead(entry.path);
		// Gone, and so not an unreadable file either, if it was listed as one. A
		// file moved into a folder that was then deleted is told, on a feed that
		// reports folders alone, as this entry and the folder's deletion: no
		// deletion of its own will come, and the folder's finds the record at
		// the path the file had before. If it has only moved on again, its next
		// entry is read and lists it again.
		if (found === 'gone') {
			return [
				...forgetUnread({ batch, decided }, (remoteId) => remoteId === entry.remoteId),
				...goneBeforeRead(local, entry, decided),
			];
		}
		if (found === 'unreadable') return leaveUnread(local, removed, entry, { batch, decided });
		const { content } = found;
		const stranger = local !== undefined && !removed && isStranger(local, content);
		if (local === undefined || stranger) {
			const aside = stranger
				? await displaceOccupant(entry.path, undefined, decided, claimed)
				: room;
			return [
				...cleared,
				...aside,
				{
					kind: 'upsert-note',
					id: await idForNewNote(content, { batch, decided: [...decided, ...aside] }),
					path: entry.path,
					content,
					remote: entry,
					syncedHash: await contentHash(content),
				},
			];
		}
		if (removed) {
			return [
				...cleared,
				...room,
				{
					kind: 'upsert-note',
					id: local.id,
					path: entry.path,
					content,
					remote: entry,
					syncedHash: await contentHash(content),
				},
			];
		}
		return [
			...cleared,
			...room,
			...(await decideKnown(local, found, entry, claimed, after, renaming)),
		];
	};

	/**
	 * A note's file renamed to a name that is not a note's: it is a file now,
	 * and the note lets go of it as it would of a file deleted — gone if
	 * clean, cut loose and sent again if not.
	 */
	const noteNoLonger = async (
		entry: RemoteEntry,
		decided: readonly PullChange[]
	): Promise<PullChange[]> => {
		const note =
			(await store.noteByRemoteId(entry.remoteId)) ??
			madeInBatch(decided).find((each) => each.remoteId === entry.remoteId);
		// Taken already, by a folder's deletion in front of this: once is enough.
		if (note === undefined || removedInBatch(note, decided)) return [];
		return remoteNow(note, decided) === entry.remoteId ? [forgetNote(note)] : [];
	};

	return { resolutionFor, fileState, stillThere, forgetNote, keepNote, decideFile, noteNoLonger };
};

/** What the pull's other parts are handed of it. */
export type PullNotes = ReturnType<typeof createPullNotes>;
