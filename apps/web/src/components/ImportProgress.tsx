import { type SyncProgress } from '@skysa/core';
import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type ApiClient } from '../api/client.js';
import { useSuspendShortcuts } from '../commands/context.js';
import { saying } from '../errors/reached.js';
import { db, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import { cancelImport, type CancelImportResult, PROVIDER_LABELS } from '../sync/account.js';
import { syncScheduler, useSyncStatus } from '../sync/runtime.js';
import { type SchedulerStatus, type SyncScheduler } from '../sync/scheduler.js';

/**
 * A source's first import, as it happens, and the way out of it.
 *
 * What it says comes from the scheduler (`status.progress`, from the engine's
 * `onProgress`): a scan lists every note before it downloads one, so while it
 * is listing it says how many so far and draws a bar that does not pretend to
 * know; once it has the whole count, and while it uploads, the bar is a
 * fraction, with the file it is on written faintly beneath.
 *
 * The first source gets it as a dialog over the app, which is held for as long
 * as it runs (`ImportDialog`, `routes/index.tsx`): the device's notes are being
 * moved into the source, and nothing may be done to them meanwhile. A later
 * source gets it in the storage panel instead, and the app carries on.
 */

const count = (n: number): string => n.toLocaleString();

/** What the import is doing, in a sentence. Exported for its tests. */
export const importMessage = (status: SchedulerStatus, label: string): string => {
	switch (status.phase) {
		case 'syncing':
			return progressMessage(status.progress, label);
		case 'idle':
			return 'Finishing…';
		case 'offline':
			return 'Offline. The import carries on when the connection is back.';
		case 'retrying':
			return `Could not reach ${label}. Trying again shortly.`;
		case 'attention':
			return `The import has stopped: ${status.error ?? 'something went wrong'}. Cancel, and connect ${label} again.`;
		case 'local':
			return 'Getting ready…';
	}
};

const progressMessage = (progress: SyncProgress | undefined, label: string): string => {
	if (progress === undefined) return 'Getting ready…';
	if (progress.stage === 'uploading') {
		return `Uploading notes to ${label}: ${count(progress.done)} of ${count(progress.total)}.`;
	}
	const { found, done } = progress;
	return progress.listing
		? `Looking for notes in ${label}: ${count(found)} found so far.`
		: `Downloading notes from ${label}: ${count(done)} of ${count(found)}.`;
};

/** How full the bar is, or nothing for a bar that cannot know. */
const fraction = (status: SchedulerStatus): { value: number; max: number } | undefined => {
	const { progress } = status;
	if (status.phase !== 'syncing' || progress === undefined) return undefined;
	if (progress.stage === 'uploading') return { value: progress.done, max: progress.total };
	if (progress.listing || progress.found === 0) return undefined;
	return { value: progress.done, max: progress.found };
};

/** How much of a path's end is kept whole when it is cut. */
const KEPT_END = 24;

/**
 * A path too long for its line, cut in the middle: its start says where the
 * file is and its end which file it is, and the end is the half that matters.
 * CSS cuts only the end of a line, so the text is two spans and only the first
 * gives way (`.import-file-start`); a path that fits shows whole. Split by code
 * point, so a character outside the BMP is never cut in half.
 */
const MiddleCut = ({ text }: { text: string }) => {
	const points = [...text];
	const at = Math.max(0, points.length - KEPT_END);
	return (
		<>
			<span className="import-file-start">{points.slice(0, at).join('')}</span>
			<span className="import-file-end">{points.slice(at).join('')}</span>
		</>
	);
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
			message: `The server would not disconnect ${label}, so the import goes on.`,
		};
	}
	if (result.outcome === 'written') {
		return {
			kind: 'said',
			message: `Something has been written in ${label} since it was connected, so it is kept. Disconnect it from the storage panel to decide what becomes of that.`,
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
						answered: `The server could not disconnect ${label}, so the import goes on.`,
						unreachable: `The server cannot be reached, so ${label} is still connected there and the import goes on.`,
						device: 'Something on this device went wrong. Try again.',
						unknown: 'Something went wrong. Try again.',
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
	source.provider === undefined ? 'storage' : PROVIDER_LABELS[source.provider];

/** The words, the bar and the buttons, wherever they are shown. */
const ImportBody = ({
	source,
	cancelRef,
	messageId,
	...seams
}: ImportPanelProps & {
	cancelRef?: Ref<HTMLButtonElement>;
	messageId?: string;
}) => {
	const label = labelOf(source);
	const status = useSyncStatus(seams.sync ?? syncScheduler);
	const path = status.phase === 'syncing' ? status.progress?.path : undefined;
	const { state, cancel, dismiss } = useCancel(source, label, seams);
	const bar = fraction(status);
	const busy = state.kind === 'busy';
	return (
		<div className="import-body">
			{/* Polite: it changes every few files, and a reader should hear it
			    when it has a moment, not be interrupted by every count. */}
			<p id={messageId} role="status" aria-live="polite">
				{busy ? 'Cancelling…' : importMessage(status, label)}
			</p>
			{bar === undefined ? (
				<progress className="import-bar" aria-label="Import progress" />
			) : (
				<progress
					className="import-bar"
					aria-label="Import progress"
					value={bar.value}
					max={Math.max(bar.max, 1)}
				/>
			)}
			{/* Not live: it changes with every file, faster than anyone could
			    listen, and the count above already says how far it has got. A
			    space holds its line, so the buttons do not jump as it comes and
			    goes. */}
			<p className="import-file" title={path}>
				{path === undefined ? '\u00a0' : <MiddleCut text={path} />}
			</p>
			{(state.kind === 'said' || state.kind === 'unreached') && (
				<p className="import-problem" role="alert">
					{state.message}
				</p>
			)}
			<div className="modal-actions">
				<button
					ref={cancelRef}
					type="button"
					disabled={busy}
					onClick={() => {
						cancel(true);
					}}
				>
					{state.kind === 'unreached' ? 'Try again' : 'Cancel'}
				</button>
				{state.kind === 'unreached' && (
					<>
						<button
							type="button"
							onClick={() => {
								cancel(false);
							}}
						>
							Cancel here anyway
						</button>
						<button type="button" onClick={dismiss}>
							Keep importing
						</button>
					</>
				)}
			</div>
		</div>
	);
};

/**
 * In the storage panel, for a source that is not the first: the app is not
 * held, and this is only where the import says how it is going.
 */
export const ImportPanel = (props: ImportPanelProps) => <ImportBody {...props} />;

/**
 * Over everything, for the first source: the app behind it is `inert`
 * (`routes/index.tsx`), so this is all there is to press. Cancel has the focus,
 * Tab stays in the dialog, and the shortcuts are held, as for any modal
 * question (`ConfirmDialog`). Escape does nothing: an import of many minutes
 * is not something a stray key should throw away.
 */
export const ImportDialog = (props: ImportPanelProps) => {
	const { source } = props;
	const titleId = useId();
	const messageId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	useSuspendShortcuts();

	useEffect(() => {
		cancel.current?.focus();
	}, []);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Tab') return;
			const buttons = [...element.querySelectorAll('button:not(:disabled)')];
			const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
			event.preventDefault();
			(buttons[next] as HTMLElement | undefined)?.focus();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, []);

	return createPortal(
		<div className="modal-backdrop">
			<div
				ref={dialog}
				className="modal import-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={messageId}
			>
				<h2 id={titleId}>Connecting {labelOf(source)}</h2>
				<ImportBody {...props} cancelRef={cancel} messageId={messageId} />
			</div>
		</div>,
		document.body
	);
};

/** The dialog while the first source's import holds the app, and nothing after. */
export const HeldImport = ({ source }: { source: SyncStateRecord | undefined }) =>
	source === undefined ? null : <ImportDialog source={source} />;
