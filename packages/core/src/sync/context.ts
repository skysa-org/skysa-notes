import { type EntryRef, type RemoteEntry, type StorageProvider } from '../providers/types.js';
import { type Meter } from './progress.js';
import {
	type ConflictResolution,
	type PullChange,
	type SyncNote,
	type SyncStore,
} from './store.js';

/**
 * What every part of the engine is handed by `createSyncEngine`: the provider
 * and the store it syncs between, the clock and ids injected for tests, its
 * bounds, a way to renew the token, and the meter that tells `onProgress` how
 * far a run has got. Built once per engine, so the parts moved out of
 * `engine.ts` (#446) share one rather than each closing over its own.
 */
export interface EngineContext {
	readonly provider: StorageProvider;
	readonly store: SyncStore;
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
