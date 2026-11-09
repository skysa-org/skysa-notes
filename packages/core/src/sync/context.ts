import type { DocumentFormat } from '../documentFormat.js';
import type { DocumentNames } from '../names/conflicts.js';
import type { EntryRef, RemoteEntry, StorageProvider } from '../providers/types.js';
import type { Meter } from './progress.js';
import type { ConflictResolution, PullChange, SyncNote, SyncStore } from './store.js';

/**
 * What every part of the engine is handed by `createSyncEngine`: the provider
 * and the store it syncs between, what a document is and what its names say,
 * the clock and ids injected for tests, its bounds, a way to renew the token,
 * the meter that tells `onProgress` how far a run has got, and the two sides
 * of a file made one where the app can make them one (`mergedOf`). Built once
 * per engine, so the parts moved out of `engine.ts` (#446) share one rather
 * than each closing over its own.
 */
export interface EngineContext {
	readonly provider: StorageProvider;
	readonly store: SyncStore;
	/** What the app's documents are (`DocumentFormat`): the engine asks it, never a file format of its own. */
	readonly document: DocumentFormat;
	/** The names `document`'s extension makes: which are documents', and where a copy goes. */
	readonly names: DocumentNames;
	readonly now: () => Date;
	readonly newId: () => string;
	/** Times an op may fail before the engine stops asking and surfaces it. */
	readonly maxAttempts: number;
	/** Writes the provider takes at once, at least one. */
	readonly writesAtOnce: number;
	/**
	 * Mint a fresh access token through the caller's `reauthorize`, and say
	 * whether there was one to call. Nothing here counts the calls: a caller
	 * asks after an `AuthError`, and at most once a run — the pull retries its
	 * attempt once, the push resumes its drain once (`retriedAuth`), and a
	 * second refusal is `paused`.
	 */
	readonly renew: () => Promise<boolean>;
	readonly meter: Meter;
	/**
	 * The two sides made one, or none: none without the engine's `merge`, and
	 * none where it throws, since a merge that cannot be made is a conflict
	 * copy, which keeps both, and never a sync that stops
	 * (docs/ARCHITECTURE.md §7, "Merge before the copy").
	 */
	readonly mergedOf: (path: string, local: string, remote: string) => string | undefined;
}

/**
 * What the push asks of the engine's pull side, which asks the same: whether
 * a file is there (`fileState`), and how a note and a newer remote version are
 * reconciled (`resolutionFor`). Handed to the push's parts by name.
 */
export interface FromPull {
	fileState: (ref: EntryRef) => Promise<'there' | 'gone' | 'unreadable'>;
	resolutionFor: (
		local: SyncNote,
		remoteContent: string,
		remote: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	) => Promise<ConflictResolution>;
}
