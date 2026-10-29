import type { SyncProgress } from '@skysa/core';

import { type MessageKey, t } from '../i18n/t.js';

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

/**
 * A run's count, as every view of it reads one (#455): a scan or a round still
 * listing, which knows how many so far and not of how many, or one sending or
 * receiving, which knows both. A scan past its listing receives what it found.
 */
export type RunCount =
	| { kind: 'looking' | 'checking'; count: number }
	| { kind: 'sending' | 'receiving'; done: number; total: number };

export const runCount = (progress: SyncProgress): RunCount => {
	if (progress.stage === 'uploading') {
		return { kind: 'sending', done: progress.done, total: progress.total };
	}
	if (progress.stage === 'scanning') {
		return progress.listing
			? { kind: 'looking', count: progress.found }
			: { kind: 'receiving', done: progress.done, total: progress.found };
	}
	return progress.listing
		? { kind: 'checking', count: progress.total }
		: { kind: 'receiving', done: progress.done, total: progress.total };
};

/**
 * How full a run's bar is, or null for a bar that cannot know: one still
 * listing, or one of nothing.
 */
export const runBar = (
	progress: SyncProgress | undefined
): { value: number; max: number } | null => {
	if (progress === undefined) return null;
	const count = runCount(progress);
	switch (count.kind) {
		case 'looking':
		case 'checking':
			return null;
		case 'sending':
		case 'receiving':
			return count.total === 0 ? null : { value: count.done, max: count.total };
	}
};

/**
 * Whose words a run's count is said in: a sync's, in the storage panel, or a
 * first import's, which uploads and downloads notes rather than sending and
 * receiving changes. Both say the listing alike.
 */
const MOVING = {
	sync: { sending: 'account.status.sending', receiving: 'account.status.receiving' },
	import: { sending: 'firstImport.uploading', receiving: 'firstImport.downloading' },
} as const satisfies Record<string, Record<'sending' | 'receiving', MessageKey>>;

/** How far a run has got, in a sentence that names the source. */
export const runSentence = (
	progress: SyncProgress,
	label: string,
	as: keyof typeof MOVING
): string => {
	const count = runCount(progress);
	switch (count.kind) {
		case 'looking':
			return t('account.status.looking', { provider: label, count: count.count });
		case 'checking':
			return t('account.status.checkingFound', { provider: label, count: count.count });
		case 'sending':
		case 'receiving':
			return t(MOVING[as][count.kind], {
				provider: label,
				done: count.done,
				total: count.total,
			});
	}
};
