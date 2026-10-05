import type { SyncProgress } from '@skysa/core';

/**
 * From how many a run's count is said. A run of a few — an edit sent, a
 * notebook made — is over before a count could be read, and a bar for each
 * would flash under the line every time the user stopped typing; the runs
 * worth counting are an import's thousand notes, sent from one device and
 * received on another (docs/ARCHITECTURE.md §7, "Sync loop").
 */
export const PROGRESS_FROM = 20;

/**
 * A run long enough to count: what the storage panel gives a count and a bar,
 * and what keeps the screen on (`wakeLock.ts`). A scan still listing counts by
 * what it has found so far.
 */
export const isLongRun = (progress: SyncProgress | undefined): progress is SyncProgress =>
	progress !== undefined &&
	(progress.stage === 'scanning' ? progress.found : progress.total) >= PROGRESS_FROM;
