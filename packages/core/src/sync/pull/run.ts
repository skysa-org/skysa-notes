import {
	type ChangeEntry,
	type ChangeSet,
	isAuthError,
	isCursorResetError,
} from '../../providers/types.js';
import { type EngineContext } from '../context.js';
import { metIn, metOf, ok, paused, type SyncOutcome } from '../outcome.js';
import { type PullChange } from '../store.js';
import { type PullAttachments } from './attachments.js';
import { unreadMap } from './batch.js';
import { type Cascade } from './cascade.js';
import { isNoteEntry, type PullDecide } from './decide.js';
import { type PullReconcile } from './reconcile.js';

/**
 * A pull, run: a round from the stored cursor, its pages read whole and then
 * decided (`drainRound`), or a scan from the top, applied a page at a time and
 * reconciled at the end (`drainScan`, `applyScan`); a cursor the provider has
 * let go of answered with a scan, and an expired token, in either, with one
 * retry after a refresh (`runPull`, `authRetry`). Moved out of `engine.ts`
 * (#446).
 */

/**
 * Where a copy of the user's writing was made. Not a note moved aside for a
 * file that cannot be read: nothing was edited twice there and no copy was
 * made, and reported here the user is told the one thing that did not
 * happen. The record says it instead, and keeps saying it
 * (`UnreadableFile.movedAside`).
 */
const conflictPathsIn = (changes: readonly PullChange[]): string[] =>
	changes.flatMap((change) => (change.kind === 'conflict' ? [change.resolution.copyPath] : []));

interface PullProgress {
	pulled: number;
	conflicts: readonly string[];
	seen: ReadonlySet<string>;
	/** Whether a page so far met the clipboard's folder. */
	clipboard?: true;
	/** Whether a page so far met the key file. */
	encryption?: true;
}

export const createPullRun = (
	{ provider, store, renew, meter }: EngineContext,
	{
		letGo,
		decideAll,
		deduped,
		fileBaseOf,
		reconcile,
		renamesQueued,
	}: {
		letGo: (entries: readonly ChangeEntry[]) => void;
	} & Pick<PullDecide, 'decideAll' | 'deduped'> &
		Pick<PullAttachments, 'fileBaseOf'> &
		Pick<PullReconcile, 'reconcile'> &
		Pick<Cascade, 'renamesQueued'>
) => {
	/**
	 * Every page of a round from a stored cursor, read before anything is
	 * decided. A round is one batch however the provider pages it: Graph asks
	 * for the whole round to be applied before its state is consistent, and a
	 * page boundary falls wherever the page size says — between a folder's
	 * deletion and the move of a subfolder out of it, whose cascade would
	 * otherwise take the subfolder's clean notes; between a folder's two moves
	 * in one window, the second of which is decided against a store that never
	 * saw the first. The decisions already reason about a batch as a whole, so
	 * one batch gets the answers one page would.
	 */
	const readRound = async (
		cursor: string,
		entries: readonly ChangeEntry[]
	): Promise<{ entries: ChangeEntry[]; cursor: string }> => {
		const set = await provider.changes(cursor);
		const all = [...entries, ...set.entries];
		meter.roundListed(set.entries.filter(isNoteEntry).map((entry) => entry.remoteId));
		return set.more ? readRound(set.cursor, all) : { entries: all, cursor: set.cursor };
	};

	/** A round's pages, then its decisions, counted as it goes (`meter`). */
	const countedRound = async (
		cursor: string
	): Promise<{ round: { entries: ChangeEntry[]; cursor: string }; changes: PullChange[] }> => {
		const round = await readRound(cursor, []);
		// Counted as `decideAll` will see them, one entry per file. Said even
		// when it is none, so that what is said is no longer that it is reading.
		meter.roundListingDone(deduped(round.entries).filter(isNoteEntry).length);
		return { round, changes: await decideAll(round.entries, false) };
	};

	const drainRound = async (cursor: string): Promise<SyncOutcome> => {
		const { round, changes } = await meter.round(() => countedRound(cursor));
		await store.applyChanges({ changes, cursor: round.cursor });
		letGo(round.entries);
		return ok({
			pulled: changes.length,
			conflicts: conflictPathsIn(changes),
			...metIn(round.entries),
		});
	};

	/**
	 * A scan's pages, all of them, before any is decided. Pages of a scan carry
	 * no cursor (below), so an interrupted scan starts from the top whether or
	 * not it had read ahead — and reading ahead is what lets it say how many
	 * notes there are before it downloads the first.
	 */
	const listScan = async (
		cursor: string | undefined,
		pages: readonly ChangeSet[]
	): Promise<readonly ChangeSet[]> => {
		const set = await provider.changes(cursor);
		meter.scanListed(set.entries.filter(isNoteEntry).map((entry) => entry.remoteId));
		const all = [...pages, set];
		return set.more ? listScan(set.cursor, all) : all;
	};

	/**
	 * A scan, page by page. It reports what exists and never what was removed
	 * until `reconcile` on its last page, so the cascade a round is read whole
	 * to avoid cannot happen here, and applying as it goes keeps a first sync of
	 * many notes visible as it arrives rather than all at the end.
	 */
	const drainScan = async (
		/**
		 * This scan is the recovery from a reset the provider said may have lost
		 * something of its own, so what it does not return is sent back up
		 * rather than deleted here. Carried through the pages because only the
		 * last one reconciles.
		 */
		upload = false
	): Promise<SyncOutcome> => {
		const pages = await listScan(undefined, []);
		meter.scanListingDone();
		return applyScan(pages, { pulled: 0, conflicts: [], seen: new Set() }, upload);
	};

	const applyScan = async (
		pages: readonly ChangeSet[],
		progress: PullProgress,
		upload: boolean
	): Promise<SyncOutcome> => {
		const [set, ...rest] = pages;
		if (set === undefined) {
			return ok({
				pulled: progress.pulled,
				conflicts: progress.conflicts,
				...metOf(progress),
			});
		}
		const more = rest.length > 0;
		const queue = await store.pendingOps();
		const unread = unreadMap(await store.unreadable());
		const files = await fileBaseOf(queue);
		const changes = await decideAll(set.entries, true, queue, unread, files);
		const seen = new Set([
			...progress.seen,
			...set.entries.flatMap((entry) =>
				entry.remoteId === undefined ? [] : [entry.remoteId]
			),
		]);

		// A scan is one logical batch: its pages carry no cursor, and the last
		// one carries both the cursor and whatever the scan proved was deleted.
		const tail = more
			? []
			: await reconcile(seen, changes, renamesQueued(queue), upload, unread, files);
		const batch = [...changes, ...tail];
		await store.applyChanges({ changes: batch, ...(more ? {} : { cursor: set.cursor }) });
		// This page's notes only: a scan retried after failing on a later page
		// commits this one again first, and what that later page had read is
		// still to be used.
		letGo(set.entries);

		// Every note on the page is dealt with now, read or already held.
		meter.scanSettled(set.entries.filter(isNoteEntry).length);
		return applyScan(
			rest,
			{
				pulled: progress.pulled + batch.length,
				conflicts: [...progress.conflicts, ...conflictPathsIn(batch)],
				seen,
				...metOf(progress),
				...metIn(set.entries),
			},
			upload
		);
	};

	const runPull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		/** A scan from the top, counted from nothing. */
		const scan = (upload = false): Promise<SyncOutcome> => meter.scan(() => drainScan(upload));
		/**
		 * The scan a dead cursor was answered with, once one has been, and
		 * whether the provider asked for what it did not return to be sent back
		 * up. A retry after a refresh goes straight back to that scan: the
		 * stored cursor is still the one the provider refused (below), and
		 * asking it again costs a request, shows a round for a moment, and
		 * leaves `uploadDifferences` to a second refusal that may say less.
		 */
		const rescan = new Map<'upload', boolean>();
		const attempt = (): Promise<SyncOutcome> => {
			const upload = rescan.get('upload');
			if (upload !== undefined) return scan(upload);
			return (stored === undefined ? scan() : drainRound(stored)).catch((error: unknown) => {
				// The cursor is dead rather than the request. Discarding it and
				// scanning is the documented recovery, and the stored one is left
				// in place so an interrupted rescan tries again rather than
				// continuing from a cursor the provider has already rejected —
				// which is also what keeps `uploadDifferences` across an
				// interruption, since the same cursor meets the same refusal and is
				// told the same thing.
				if (isCursorResetError(error)) {
					rescan.set('upload', error.uploadDifferences === true);
					return scan(error.uploadDifferences === true);
				}
				throw error;
			});
		};

		// Around the recovery, not beside it: a token can expire in the scan
		// that answers a dead cursor, and a cursor can turn out dead on the
		// retry after a refresh. Beside it, either ended the run as `retry`.
		return attempt().catch((error: unknown) => {
			if (isAuthError(error)) return authRetry(attempt);
			throw error;
		});
	};

	/** One retry after a refresh, for a pull that met an expired token. */
	const authRetry = async (again: () => Promise<SyncOutcome>): Promise<SyncOutcome> => {
		if (!(await renew())) return paused();
		return again().catch((error: unknown) => {
			if (isAuthError(error)) return paused();
			throw error;
		});
	};

	return { runPull };
};
