import { type StorageProvider } from '../providers/types.js';
import { type Meter } from './progress.js';
import { type SyncStore } from './store.js';

/**
 * What every part of the engine is handed by `createSyncEngine`: the provider
 * and the store it syncs between, the clock and ids injected for tests, its
 * bounds, and the meter that tells `onProgress` how far a run has got. Built
 * once per engine, so the parts moved out of `engine.ts` (#446) share one
 * rather than each closing over its own.
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
	readonly meter: Meter;
}
