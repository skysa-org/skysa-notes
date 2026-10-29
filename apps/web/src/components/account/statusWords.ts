import { type EntitlementCode, type SyncProgress } from '@skysa/core';

import { type Refusal } from '../../api/client.js';
import { saying } from '../../errors/reached.js';
import { type MessageKey, t } from '../../i18n/t.js';
import { isLongRun } from '../../sync/progress.js';
import { needsReconnect } from '../../sync/runtime.js';
import { type SchedulerStatus, type StuckOp } from '../../sync/scheduler.js';

/**
 * Why a disconnect did not happen. `credential_revoked` and `not_found` never
 * arrive here — `disconnectAccount` counts those as the disconnect having
 * already happened — so what is left is a server that declined a live
 * credential, which the user can do nothing about except stop syncing here.
 */
export const refusalMessage = (refusal: Refusal): string =>
	refusal === 'not_entitled'
		? t('account.disconnect.refused.notEntitled')
		: t('account.disconnect.refused.declined');

/**
 * Why a disconnect did not happen, where it failed rather than being refused.
 *
 * Four answers, because there are four different things it can have been and no
 * two are the same thing to do about. A server that answered with a failure is
 * worth trying again; a server that never answered is worth looking at the
 * connection for; a failure that never left the device is neither, since "stop
 * syncing on this device" asks the server nothing at all and a message about a
 * connection would send the user to the one part that was not used. And a
 * failure from neither call cannot say where it happened, so it does not.
 *
 * Which it was comes from `letGoOfSource`, which knows because it made the call
 * (`errors/reached.ts`), rather than from the shape or the words of the error.
 * What it does *not* know is whether the work landed, so no wording here says.
 *
 * And the last two say what is not known about the outcome, which differs by
 * what was asked of whom (`onServer`).
 *
 * Everything after the disconnect itself is this device's work
 * (`letGoOfSource`), so a failure of the device half can be one that ran before
 * the server was asked or one that ran after it said yes — the account gone at
 * the provider, its refresh token with it, and this device still bound to it.
 * Saying "the account was not disconnected" there was simply false. With
 * nothing asked of the server there is no such doubt, and the doubt is about
 * this device instead.
 *
 * Trying again is safe from either: a second attempt presents a credential the
 * server has already spent, which comes back `credential_revoked` or
 * `not_found`, and `disconnectAccount` counts both as the disconnect having
 * happened.
 */
export const failureMessage = (error: unknown, onServer: boolean): string =>
	saying(error, {
		answered: t('account.disconnect.failed.answered'),
		unreachable: t('account.disconnect.failed.unreachable'),
		device: onServer
			? t('account.disconnect.failed.deviceOnServer')
			: t('account.disconnect.failed.deviceHere'),
		unknown: onServer
			? t('account.disconnect.failed.unknownOnServer')
			: t('account.disconnect.failed.unknownHere'),
	});

/** A time today as a time, and any other as a date. */
export const when = (at: number): string => {
	const date = new Date(at);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
		: date.toLocaleDateString();
};

/**
 * How far a long run has got: the status line, with a few words after the
 * source's name, the sentence for its tooltip and for the panel in a compact
 * window, and how full its bar is — `null` while a scan or a round is still
 * listing, which knows how many so far and not of how many.
 */
export interface SyncCount {
	text: string;
	sentence: string;
	bar: { value: number; max: number } | null;
}

/** A long run's count, or nothing for a run too short to count. */
export const syncCount = (
	progress: SyncProgress | undefined,
	label: string
): SyncCount | undefined => {
	if (!isLongRun(progress)) return undefined;
	if (progress.stage === 'scanning') return scanCount(progress, label);
	if (progress.stage === 'receiving' && progress.listing) {
		return {
			text: t('account.line.checkingFound', { count: progress.total }),
			sentence: t('account.status.checkingFound', { provider: label, count: progress.total }),
			bar: null,
		};
	}
	const counted = { done: progress.done, total: progress.total };
	const of = { provider: label, ...counted };
	const bar = { value: progress.done, max: progress.total };
	return progress.stage === 'uploading'
		? {
				text: t('account.line.sending', counted),
				sentence: t('account.status.sending', of),
				bar,
			}
		: {
				text: t('account.line.receiving', counted),
				sentence: t('account.status.receiving', of),
				bar,
			};
};

const scanCount = (
	{ found, done, listing }: Extract<SyncProgress, { stage: 'scanning' }>,
	label: string
): SyncCount => {
	if (listing) {
		return {
			text: t('account.line.looking', { count: found }),
			sentence: t('account.status.looking', { provider: label, count: found }),
			bar: null,
		};
	}
	const of = { provider: label, done, total: found };
	return {
		text: t('account.line.receiving', { done, total: found }),
		sentence: t('account.status.receiving', of),
		bar: { value: done, max: found },
	};
};

/**
 * What a run is looking through, before it has found enough to count
 * (`PROGRESS_FROM`): the pages of what has changed, or of a re-scan. Said from
 * the first, since that can be long — another device's notebooks moved was
 * minutes of "Syncing…" on a phone (2026-10-13) — but with no bar, which on
 * every quiet sync would flash under the line.
 */
const listingWords = (
	progress: SyncProgress | undefined,
	label: string
): { text: string; sentence: string } | undefined => {
	if (progress?.stage === 'receiving' && progress.listing) {
		return {
			text: t('account.line.checking'),
			sentence: t('account.status.checking', { provider: label }),
		};
	}
	if (progress?.stage === 'scanning' && progress.listing) {
		return {
			text: t('account.line.lookingStart'),
			sentence: t('account.status.lookingStart', { provider: label }),
		};
	}
	return undefined;
};

/**
 * How syncing is going, in words, or nothing to say. A refusal that connecting
 * again would fix is not said here: the panel offers to connect again instead.
 */
export const statusMessage = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): string | null => {
	switch (status.phase) {
		case 'local':
			return null;
		case 'syncing':
			if (status.waiting === true) return t('account.status.waiting');
			return (
				syncCount(status.progress, label)?.sentence ??
				listingWords(status.progress, label)?.sentence ??
				t('account.status.syncing')
			);
		case 'idle':
			return status.lastSyncAt === undefined
				? t('account.status.synced')
				: t('account.status.syncedAt', { time: when(status.lastSyncAt) });
		case 'offline':
			return t('account.status.offline');
		case 'paused':
			return t('account.status.paused', { provider: label });
		case 'retrying':
			return t('account.status.retrying', { provider: label, error: errorOf(status) });
		case 'attention':
			return attentionMessage(status, label, syncable);
	}
};

/** What went wrong, as the provider or the browser said it, for the end of a sentence. */
const errorOf = ({ error }: { error?: string | undefined }): string =>
	error ?? t('account.status.unknownError');

/**
 * Why the server will not sync the account, by the kind of refusal its
 * operator's policy gave (`ENTITLEMENT_CODES`), as a sentence of its own. With
 * none, what it always said: a refusal is still a refusal from a policy that
 * does not say which. The connect toast says the same reasons in its own
 * sentences (`refusedText` in `routes/-home/connectNotice.ts`).
 */
const refusedSentence = (code: EntitlementCode | undefined): string => {
	switch (code) {
		case 'not_allowed':
			return t('account.status.refused.notAllowed');
		case 'lapsed':
			return t('account.status.refused.lapsed');
		case 'limit_reached':
			return t('account.status.refused.limitReached');
		case undefined:
			return t('account.status.refused.unspecified');
	}
};

const attentionMessage = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): string | null => {
	// Said as what to do, with the link, instead.
	if (needsReconnect(status)) return null;
	if (!syncable) return t('account.status.cannotSync', { provider: label });
	if (status.refusal === 'not_entitled') return refusedSentence(status.denial?.code);
	if (status.refusal === 'not_found') return t('account.status.notFound', { provider: label });
	if (status.stuck !== undefined) return stuckMessage(status.stuck, label);
	return t('account.status.notSent', { provider: label, error: errorOf(status) });
};

/**
 * How syncing is going, as the status line at the foot of the sidebar says it:
 * a few words, with the whole sentence, where there is more to say, as its
 * tooltip. Not the source's name, which the selected tab above says: with it,
 * the line wrapped onto a second line and back as its words changed
 * (2026-10-14). Where syncing has stopped on something the user
 * has to deal with, the line says only that, and the sentence is said above it
 * (`SyncState`), where it stays until it is dealt with.
 */
export const lineStatus = (
	status: SchedulerStatus,
	label: string,
	syncable: boolean
): { text: string; title: string | null } => {
	switch (status.phase) {
		case 'local':
			return { text: label, title: null };
		case 'syncing':
			// Said over a count: how far it had got is not what is happening.
			if (status.waiting === true) {
				return {
					text: t('account.line.waiting'),
					title: t('account.status.waiting'),
				};
			}
			return syncingLine(status.progress, label);
		case 'idle':
			return {
				text:
					status.lastSyncAt === undefined
						? t('account.line.synced')
						: t('account.line.syncedAt', { time: when(status.lastSyncAt) }),
				title: null,
			};
		case 'offline':
			return {
				text: t('account.line.offline'),
				title: statusMessage(status, label, syncable),
			};
		case 'retrying':
			return {
				text: t('account.line.retrying'),
				title: statusMessage(status, label, syncable),
			};
		case 'attention':
			return { text: t('account.line.notSyncing'), title: null };
		case 'paused':
			return {
				text: t('account.line.paused'),
				title: statusMessage(status, label, syncable),
			};
	}
};

/**
 * A run, in the status line: how far it has got where it is long enough to
 * count, with the sentence and the file it is on in the tooltip.
 */
const syncingLine = (
	progress: SyncProgress | undefined,
	label: string
): { text: string; title: string | null } => {
	const count = syncCount(progress, label);
	if (count === undefined) {
		const words = listingWords(progress, label);
		return words === undefined
			? { text: t('account.line.syncing'), title: null }
			: { text: words.text, title: words.sentence };
	}
	return {
		text: count.text,
		title: [count.sentence, progress?.path].filter((line) => line !== undefined).join('\n'),
	};
};

/**
 * What a stuck op was trying to do, in the user's terms. `mkdir` and `rmdir`
 * are about a notebook, and a file's three about a file beside a note (#187):
 * none of them has a note to open.
 *
 * `rmdir` cannot actually be stuck — the engine gives up on one rather than
 * holding the queue up (§7, "A dead `rmdir` is given up on") — but it is a
 * queued operation like any other and a label that said nothing would be worse
 * than one that is never read.
 *
 * A whole sentence for each, since what the op was decides how the rest of it
 * reads.
 */
const STUCK_MESSAGES = {
	write: 'account.stuck.write',
	move: 'account.stuck.move',
	delete: 'account.stuck.delete',
	mkdir: 'account.stuck.mkdir',
	rmdir: 'account.stuck.rmdir',
	upload: 'account.stuck.upload',
	'move-file': 'account.stuck.moveFile',
	'delete-file': 'account.stuck.deleteFile',
	malformed: 'account.stuck.malformed',
} as const satisfies Record<StuckOp['op'], MessageKey>;

/**
 * Which op is stuck, by name and path, because "some changes could not be sent"
 * leaves the user with nothing to act on — and the queue is ordered, so this
 * one op is also why everything after it is waiting.
 *
 * A `move`'s target, not its source: the name the user gave it is the one they
 * are looking for.
 */
const stuckMessage = (stuck: StuckOp, label: string): string =>
	t(STUCK_MESSAGES[stuck.op], {
		count: stuck.attempts,
		provider: label,
		path: stuck.targetPath ?? stuck.path,
		error: errorOf(stuck),
	});

export const conflictMessage = (count: number): string => t('account.conflicts', { count });
