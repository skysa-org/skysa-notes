import { type SyncProgress } from '@skysa/core';
import { useId, useState } from 'react';

import { api, type ApiClient } from '../api/client.js';
import { saying } from '../errors/reached.js';
import { t } from '../i18n/t.js';
import { db, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import { cancelImport, type CancelImportResult, PROVIDER_LABELS } from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type SyncScheduler } from '../sync/scheduler.js';
import { Dialog, DialogActions } from './Dialog.js';
import { RunProgress } from './RunProgress.js';

/**
 * A source's first import, as it happens, and the way out of it.
 *
 * What it says comes from the scheduler (`status.progress`, from the engine's
 * `onProgress`): a scan lists every note before it downloads one, so while it
 * is listing it says how many so far and draws a bar that does not pretend to
 * know; once it has the whole count, and while it uploads, the bar is a
 * fraction, with the file it is on written faintly beneath.
 *
 * A dialog over the app, which is held for as long as it runs (`ImportDialog`,
 * `routes/index.tsx`): for the first source the device's notes are being moved
 * into it, and nothing may be done to them meanwhile. For a later one too
 * (2026-10-02): it was shown in the storage panel and the app carried on,
 * into a source with nothing in it yet that offered to make a notebook.
 */

/** What the import is doing, in a sentence. Exported for its tests. */
export const importMessage = (status: SchedulerStatus, label: string): string => {
	switch (status.phase) {
		case 'syncing':
			// An import is a sync, held up on the device the same way.
			if (status.waiting === true) return t('account.status.waiting');
			return progressMessage(status.progress, label);
		case 'idle':
			return t('firstImport.finishing');
		case 'offline':
			return t('firstImport.offline');
		case 'retrying':
			return t('firstImport.retrying', { provider: label });
		case 'attention':
			return status.error === undefined
				? t('firstImport.stoppedUnknown', { provider: label })
				: t('firstImport.stopped', { error: status.error, provider: label });
		case 'local':
			return t('firstImport.gettingReady');
		// Not offered while an import holds the source (`SyncDetails`), but said
		// should it come to be.
		case 'paused':
			return t('account.status.paused', { provider: label });
	}
};

const progressMessage = (progress: SyncProgress | undefined, label: string): string => {
	if (progress === undefined) return t('firstImport.gettingReady');
	if (progress.stage === 'uploading') {
		return t('firstImport.uploading', {
			provider: label,
			done: progress.done,
			total: progress.total,
		});
	}
	if (progress.stage === 'receiving' && progress.listing) {
		return t('firstImport.checking', { provider: label, count: progress.total });
	}
	if (progress.stage === 'receiving') {
		return t('firstImport.downloading', {
			provider: label,
			done: progress.done,
			total: progress.total,
		});
	}
	const { found, done } = progress;
	return progress.listing
		? t('firstImport.listing', { provider: label, count: found })
		: t('firstImport.downloading', { provider: label, done, total: found });
};

type Cancelling =
	| { kind: 'idle' }
	| { kind: 'busy' }
	/** Said, and nothing to offer but trying again. */
	| { kind: 'said'; message: string }
	/** The server could not be asked: cancelling here alone is offered too. */
	| { kind: 'unreached'; message: string };

const outcomeMessage = (result: CancelImportResult, label: string): Cancelling => {
	if (!result.ok) {
		return {
			kind: 'unreached',
			message: t('firstImport.refused', { provider: label }),
		};
	}
	if (result.outcome === 'written') {
		return {
			kind: 'said',
			message: t('firstImport.written', { provider: label }),
		};
	}
	// Cancelled, or finished first: either way this is about to go.
	return { kind: 'idle' };
};

/** What an import is shown with; the app's own unless a test says otherwise. */
export interface ImportSeams {
	database?: NotesDatabase;
	client?: Pick<ApiClient, 'withCredential'>;
	sync?: Pick<SyncScheduler, 'halt' | 'status' | 'subscribe'>;
}

/** The cancel, and what came of it. */
const useCancel = (
	source: SyncStateRecord,
	label: string,
	{ database = db, client = api, sync = syncScheduler }: ImportSeams
) => {
	const [state, setState] = useState<Cancelling>({ kind: 'idle' });
	const cancel = (onServer: boolean) => {
		setState({ kind: 'busy' });
		cancelImport(database, client, sync, { connectionId: source.connectionId, onServer })
			.then((result) => {
				setState(outcomeMessage(result, label));
			})
			.catch((error: unknown) => {
				setState({
					kind: 'unreached',
					message: saying(error, {
						answered: t('firstImport.notCanceled.answered', { provider: label }),
						unreachable: t('firstImport.notCanceled.unreachable', { provider: label }),
						device: t('firstImport.notCanceled.device'),
						unknown: t('firstImport.notCanceled.unknown'),
					}),
				});
			});
	};
	return { state, cancel, dismiss: () => setState({ kind: 'idle' }) };
};

export interface ImportPanelProps extends ImportSeams {
	source: SyncStateRecord;
}

const labelOf = (source: SyncStateRecord): string =>
	source.provider === undefined
		? t('firstImport.unknownProvider')
		: PROVIDER_LABELS[source.provider];

/**
 * The words, the bar and the buttons. Cancel is the one button while the
 * import runs. Where the server could not be asked, the question is whether
 * to try again, which is the answer and has the focus; Keep importing is its
 * way out, and comes first.
 */
const ImportBody = ({
	source,
	messageId,
	...seams
}: ImportPanelProps & {
	messageId?: string;
}) => {
	const label = labelOf(source);
	const status = useSyncStatus(seams.sync ?? syncScheduler);
	const { state, cancel, dismiss } = useCancel(source, label, seams);
	const busy = state.kind === 'busy';
	const unreached = state.kind === 'unreached';
	return (
		<div className="import-body">
			{/* Polite: it changes every few files, and a reader should hear it
			    when it has a moment, not be interrupted by every count. */}
			<p id={messageId} role="status" aria-live="polite">
				{busy ? t('firstImport.canceling') : importMessage(status, label)}
			</p>
			<RunProgress status={status} label={t('firstImport.progress')} />
			{(state.kind === 'said' || state.kind === 'unreached') && (
				<p className="import-problem" role="alert">
					{state.message}
				</p>
			)}
			<DialogActions
				primary={
					unreached ? (
						<button
							type="button"
							className="primary"
							onClick={() => {
								cancel(true);
							}}
						>
							{t('common.tryAgain')}
						</button>
					) : undefined
				}
			>
				{unreached ? (
					<>
						<button type="button" onClick={dismiss}>
							{t('firstImport.keepImporting')}
						</button>
						<button
							type="button"
							onClick={() => {
								cancel(false);
							}}
						>
							{t('firstImport.cancelHere')}
						</button>
					</>
				) : (
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							cancel(true);
						}}
					>
						{t('common.cancel')}
					</button>
				)}
			</DialogActions>
		</div>
	);
};

/**
 * Over everything: the app behind it is `inert` (`routes/index.tsx`), so this
 * is all there is to press. A `Dialog` with no way out of its own: Escape
 * does nothing, since an import of many minutes is not something a stray key
 * should throw away, and Cancel is the import's, in its row.
 */
export const ImportDialog = (props: ImportPanelProps) => {
	const messageId = useId();
	return (
		<Dialog
			title={t('firstImport.title', { provider: labelOf(props.source) })}
			className="import-dialog"
			describedBy={messageId}
		>
			<ImportBody {...props} messageId={messageId} />
		</Dialog>
	);
};

/** The dialog while a source's first import holds the app, and nothing after. */
export const HeldImport = ({ source }: { source: SyncStateRecord | undefined }) =>
	source === undefined ? null : <ImportDialog source={source} />;
