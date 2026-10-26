import { destinationOf, type SyncOp } from './store.js';

/**
 * How far the run under way has got, for `onProgress`: a scan's count, a
 * round's, and a push's, each kept while it runs and said each time it moves.
 * The engine tells it what happened — a page listed, a note read or decided,
 * an op reached — and it keeps the count and says it.
 */

/**
 * How far a long run has got. A scan lists every page before it reads a note,
 * so while `listing` it knows only how many it has `found` so far; after that
 * `found` is the whole of it and `done` counts up to it — a note read, or one
 * this device already holds at that version and so never read, which keeps a
 * scan resumed after an interruption from claiming to fetch it all again.
 * A round from a stored cursor reads all its pages before it decides any
 * (`drainRound`), so it knows how many notes it names before it reads the
 * first: `done` counts each as it is decided, read or already held. Another
 * device's import of a thousand notes is one round, and nothing of it shows
 * until all of it is read, so this is what there is to see meanwhile. While
 * it is still reading its pages it is `listing`, as a scan is, and `total` is
 * how many notes the pages read so far name — said before the first page as
 * none, so a round that takes long over its pages says what it is doing
 * (2026-10-13: another device's notebooks moved was minutes of plain
 * "Syncing…" on a phone, before the first note was counted).
 * A push knows its queue before it starts, so it gives a total. `path` is the
 * file just read or decided, or the one about to be sent, for a caller that
 * shows it.
 */
export type SyncProgress =
	| { stage: 'scanning'; found: number; done: number; listing: boolean; path?: string }
	| { stage: 'receiving'; done: number; total: number; listing: boolean; path?: string }
	| { stage: 'uploading'; done: number; total: number; path?: string };

/**
 * A scan's count, as it goes: the notes it has listed, those on pages already
 * applied, those read so far on the page being applied, and whether it is
 * still listing.
 */
interface ScanCount {
	notes: Set<string>;
	settled: number;
	reading: number;
	listing: boolean;
}

/** The engine's one meter, as `createProgress` makes it. */
export type Meter = ReturnType<typeof createProgress>;

export const createProgress = (onProgress: (progress: SyncProgress) => void) => {
	/**
	 * The scan under way, for `onProgress`, and none during a round. Kept by
	 * the engine's one meter rather than threaded through every decision to
	 * the one place a note is read; a scheduler runs one pull at a time per
	 * engine, and each engine makes its own meter.
	 */
	const scans = new Map<'current', ScanCount>();

	/**
	 * The round under way, for `onProgress`, and none during a scan: the notes
	 * its pages name, how many it will decide and how many of them it has, and
	 * whether it is still reading its pages. Kept for the reason the scan's
	 * count is.
	 */
	const rounds = new Map<
		'current',
		{ named: Set<string>; total: number; done: number; listing: boolean }
	>();

	/** The push under way, for `onProgress`: how long its queue was. */
	const pushes = new Map<'current', number>();

	const reportRound = (path?: string) => {
		const round = rounds.get('current');
		if (round === undefined) return;
		onProgress({
			stage: 'receiving',
			done: round.done,
			total: round.total,
			listing: round.listing,
			...(path === undefined ? {} : { path }),
		});
	};

	const reportScan = (path?: string) => {
		const scanning = scans.get('current');
		if (scanning === undefined) return;
		const found = scanning.notes.size;
		onProgress({
			stage: 'scanning',
			found,
			done: Math.min(found, scanning.settled + scanning.reading),
			listing: scanning.listing,
			...(path === undefined ? {} : { path }),
		});
	};

	/** `during`, as a scan counted from nothing, said before its first page. */
	const scan = <T>(during: () => Promise<T>): Promise<T> => {
		scans.set('current', { notes: new Set(), settled: 0, reading: 0, listing: true });
		// Before the first page, which can be long in coming, as a round's is.
		reportScan();
		return during().finally(() => {
			scans.delete('current');
		});
	};

	/** The notes a scan's page names, by remote id. */
	const scanListed = (ids: readonly string[]): void => {
		const scanning = scans.get('current');
		if (scanning === undefined) return;
		ids.forEach((id) => scanning.notes.add(id));
		reportScan();
	};

	/** The scan has listed every page. */
	const scanListingDone = (): void => {
		const listed = scans.get('current');
		if (listed === undefined) return;
		scans.set('current', { ...listed, listing: false });
		reportScan();
	};

	/** A note the scan has read, at `path`. */
	const scanRead = (path: string): void => {
		const scanning = scans.get('current');
		if (scanning === undefined) return;
		scans.set('current', { ...scanning, reading: scanning.reading + 1 });
		reportScan(path);
	};

	/** A page applied, with this many notes on it. */
	const scanSettled = (notes: number): void => {
		const scanning = scans.get('current');
		if (scanning === undefined) return;
		scans.set('current', { ...scanning, settled: scanning.settled + notes, reading: 0 });
		reportScan();
	};

	/** `during`, as a round counted from nothing, said before its first page. */
	const round = <T>(during: () => Promise<T>): Promise<T> => {
		rounds.set('current', { named: new Set(), total: 0, done: 0, listing: true });
		reportRound();
		return during().finally(() => {
			rounds.delete('current');
		});
	};

	/**
	 * The notes a round's page names, by remote id: the total so far is how
	 * many the pages read so far name, said where that has grown.
	 */
	const roundListed = (ids: readonly string[]): void => {
		const counted = rounds.get('current');
		if (counted === undefined) return;
		const before = counted.named.size;
		ids.forEach((id) => counted.named.add(id));
		if (counted.named.size === before) return;
		rounds.set('current', { ...counted, total: counted.named.size });
		reportRound();
	};

	/** Every page read: the notes the round will decide, none of them yet. */
	const roundListingDone = (total: number): void => {
		const counted = rounds.get('current');
		if (counted === undefined) return;
		rounds.set('current', { ...counted, total, done: 0, listing: false });
		reportRound();
	};

	/** A note the round has decided, at `path`. */
	const roundDecided = (path: string): void => {
		const counted = rounds.get('current');
		if (counted === undefined) return;
		rounds.set('current', { ...counted, done: counted.done + 1 });
		reportRound(path);
	};

	/** `during`, as a push of this many ops. */
	const push = <T>(total: number, during: () => Promise<T>): Promise<T> => {
		pushes.set('current', total);
		return during().finally(() => {
			pushes.delete('current');
		});
	};

	/** The push with this many ops left, `next` the first of them. */
	const pushLeft = (left: number, next: SyncOp | undefined): void => {
		const total = pushes.get('current') ?? 0;
		if (total === 0) return;
		onProgress({
			stage: 'uploading',
			done: total - left,
			total,
			...(next === undefined ? {} : { path: destinationOf(next) }),
		});
	};

	return {
		scan,
		scanListed,
		scanListingDone,
		scanRead,
		scanSettled,
		round,
		roundListed,
		roundListingDone,
		roundDecided,
		push,
		pushLeft,
	};
};
