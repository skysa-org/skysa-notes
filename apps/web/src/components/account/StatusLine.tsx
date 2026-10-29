import type { ReactNode, RefObject } from 'react';

import { t } from '../../i18n/t.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import { InfoDialog } from '../ui/InfoDialog.js';
import { RunProgress } from '../ui/RunProgress.js';
import { lineStatus, statusMessage, type SyncCount } from './statusWords.js';

/**
 * How full a long run is, under what says how far it has got: a fraction, or,
 * while a scan or a round is still listing, a bar that does not pretend to know.
 */
export const SyncBar = ({ count }: { count: SyncCount }) =>
	count.bar === null ? (
		<progress className="account-bar" aria-label={t('account.progress')} />
	) : (
		<progress
			className="account-bar"
			aria-label={t('account.progress')}
			value={count.bar.value}
			max={Math.max(count.bar.max, 1)}
		/>
	);

/**
 * Where the panel ends, once there is nothing to ask the user: the source and
 * how it is going, in one line, with a connected source's count of its other
 * devices at the line's end, and the gear with everything that can be done to
 * it — at the foot of the sidebar, and of a compact window's source dropdown,
 * where the source's `⋯` has the same. What needs the user — a reconnect, a
 * problem, a question being asked — is drawn above the line while it lasts,
 * so the line is where the panel ends whatever is going on.
 */
export const StatusLine = ({
	text,
	title,
	onDetails,
	detailsRef,
	children,
}: {
	text: string;
	title: string | null;
	/**
	 * Given while the source syncs, but during a first import: the words are a
	 * button that opens how syncing is going, and with which account
	 * (`SyncDetails`). Inside the
	 * line rather than in its place, so the line is the same element whatever
	 * it says.
	 */
	onDetails?: () => void;
	detailsRef?: RefObject<HTMLButtonElement | null>;
	children: ReactNode;
}) => (
	<div className="account-line">
		<p className="account-status muted" {...(title === null ? {} : { title })}>
			{onDetails === undefined ? (
				text
			) : (
				<button
					ref={detailsRef}
					type="button"
					className="account-status-button"
					aria-haspopup="dialog"
					onClick={onDetails}
				>
					{text}
				</button>
			)}
		</p>
		{children}
	</div>
);

/**
 * What a sync is doing, at more length than the line has room for, and the
 * way to pause it — or, paused, to resume it (2026-10-13). Opened from the
 * status line, and live while open: once the run it was opened on has ended,
 * it says how syncing stands, with Close alone. Opened from it whatever it
 * says (2026-10-14), since the line no longer names the source, and this
 * does, with its account, on a phone that has no tooltip to show.
 * Paused, nothing syncs on this device until Sync now, a re-scan, the source
 * shown again after another, or a reload (`pause` in `sync/scheduler.ts`).
 */
export const SyncDetails = ({
	status,
	label,
	displayName,
	syncable,
	onPause,
	onResume,
	onClose,
	returnFocus,
}: {
	status: SchedulerStatus;
	label: string;
	displayName: string | null;
	syncable: boolean;
	onPause: () => void;
	onResume: () => void;
	onClose: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}) => {
	const syncing = status.phase === 'syncing';
	const paused = status.phase === 'paused';
	const action = syncing ? (
		<button type="button" onClick={onPause}>
			{t('account.details.pause')}
		</button>
	) : paused ? (
		<button type="button" onClick={onResume}>
			{t('account.details.resume')}
		</button>
	) : undefined;
	return (
		<InfoDialog
			title={
				paused
					? t('account.details.pausedTitle')
					: displayName === null
						? t('account.details.title', { provider: label })
						: t('account.details.titleAs', { provider: label, account: displayName })
			}
			onClose={onClose}
			actions={action}
			returnFocus={returnFocus}
		>
			<div className="run-body">
				{/* Polite, as an import's is: it changes every few files. */}
				<p role="status" aria-live="polite">
					{statusMessage(status, label, syncable) ??
						lineStatus(status, label, syncable).text}
				</p>
				{syncing && <RunProgress status={status} label={t('account.progress')} />}
				{syncing && <p className="muted">{t('account.details.pauseHint')}</p>}
			</div>
		</InfoDialog>
	);
};
