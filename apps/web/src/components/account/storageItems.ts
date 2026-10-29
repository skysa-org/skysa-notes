import { useLiveQuery } from 'dexie-react-hooks';

import { t } from '../../i18n/t.js';
import { showsClipboard } from '../../store/clipboard.js';
import type { NotesDatabase, SyncStateRecord } from '../../store/db.js';
import { getScratchpadShown, setScratchpadShown } from '../../store/scratchpad.js';
import type { Unsynced } from '../../store/unsynced.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import type { OptionsMenuItem } from '../OptionsMenu.js';
import { secretsLabel } from '../SecretsDialog.js';
import { importingHere, isSyncable } from './SyncState.js';

/**
 * Whether one last push before the question is worth waiting for. Not where the
 * scheduler is not syncing this source anyway, not where it has already stopped
 * on something it will stop on again, and not where there is no network: each
 * of those is a delay in front of the same question.
 */
export const worthPushing = (status: SchedulerStatus): boolean =>
	navigator.onLine &&
	status.phase !== 'local' &&
	status.phase !== 'attention' &&
	status.phase !== 'offline';

/**
 * Why the last push could not clear what is here, where the user would do
 * better to cancel and come back to it. Not a reason to refuse the disconnect:
 * they may have no intention of ever reaching this account again.
 */
export const stoppedBy = (
	status: SchedulerStatus,
	listed: Unsynced
): 'offline' | 'blocked' | null => {
	if (status.phase === 'offline' || !navigator.onLine) return 'offline';
	return listed.blocked ? 'blocked' : null;
};

/**
 * What can be done to a connected source, beyond what its status offers: the
 * items of the gear's menu at the foot of the sidebar, or of the `⋯` in a
 * compact window's source dropdown, disabled where they cannot be done now.
 * Neither way to let the source go while the disconnect question is open,
 * which is the way on from there.
 */
export const storageItems = ({
	bound,
	phase,
	rescanning,
	onRescan,
	download,
	imports,
	clipboard,
	scratchpad,
	secrets,
	about,
	stranded,
	open,
	disconnectBlocked,
	syncNow,
	ask,
}: {
	bound: SyncStateRecord;
	phase: SchedulerStatus['phase'];
	rescanning: boolean;
	onRescan: () => void;
	download: readonly OptionsMenuItem[];
	/** The ways to import (`importItems`), or none where an import is held back. */
	imports: readonly OptionsMenuItem[];
	/** Showing or hiding the clipboard (`clipboardItem`). */
	clipboard: readonly OptionsMenuItem[];
	/** Showing or hiding the scratchpad (`useScratchpadItem`). */
	scratchpad: readonly OptionsMenuItem[];
	/** Secrets in the source (`useSecretsItem`). */
	secrets: readonly OptionsMenuItem[];
	/** What the provider keeps from the app (`unseenItem`). */
	about: readonly OptionsMenuItem[];
	stranded: boolean;
	/** Whether the disconnect question is open. */
	open: boolean;
	disconnectBlocked: boolean;
	syncNow: () => void;
	ask: (onServer: boolean) => void;
}): OptionsMenuItem[] => {
	const syncing = phase === 'syncing';
	const syncs = !importingHere(bound) && phase !== 'local';
	return [
		...(syncs
			? [{ label: t('account.menu.syncNow'), onChoose: syncNow, disabled: syncing }]
			: []),
		...(syncs && isSyncable(bound) && !rescanning
			? [{ label: t('account.menu.rescan'), onChoose: onRescan, disabled: syncing }]
			: []),
		...download,
		...imports,
		...clipboard,
		...scratchpad,
		...secrets,
		...about,
		...(stranded && !open
			? [
					{
						label: t('account.menu.stopHere'),
						// The same question again, and nothing asked of the server:
						// it has already refused, and nothing on it is touched.
						onChoose: () => {
							ask(false);
						},
					},
				]
			: []),
		...(open
			? []
			: [
					{
						label: t('account.menu.disconnect'),
						onChoose: () => {
							ask(true);
						},
						danger: true,
						disabled: disconnectBlocked,
					},
				]),
	];
};

/**
 * Show the source's clipboard on this device, or stop (docs/ARCHITECTURE.md
 * §7, "The clipboard"). Said as what choosing it does, as a notebook's "Pin to
 * top" is. Not while a first import holds the source, as "Sync now" is not.
 */
export const clipboardItem = (
	bound: SyncStateRecord,
	phase: SchedulerStatus['phase'],
	onChoose: () => void
): OptionsMenuItem[] =>
	importingHere(bound) || phase === 'local'
		? []
		: [
				{
					label: showsClipboard(bound)
						? t('account.menu.hideClipboard')
						: t('account.menu.showClipboard'),
					onChoose,
				},
			];

/**
 * Show the source's scratchpad on this device, or stop (docs/ARCHITECTURE.md
 * §7, "The scratchpad"). Offered for every source, the device's own among
 * them, since a scratch note is a note like any other and needs no sync to be
 * one. Shown, the route opens it (`useOpenWhenShown`); hidden, its notes stay
 * where they are, and come back as they were. With whether it is shown, which
 * the import into it asks (`importItems`).
 */
export const useScratchpadItem = (
	database: NotesDatabase,
	connectionId: string
): { shown: boolean | undefined; items: OptionsMenuItem[] } => {
	const shown = useLiveQuery(
		() => getScratchpadShown(database, connectionId),
		[database, connectionId]
	);
	return {
		shown,
		items:
			shown === undefined
				? []
				: [
						{
							label: shown
								? t('account.menu.hideScratchpad')
								: t('account.menu.showScratchpad'),
							onChoose: () => {
								void setScratchpadShown(database, connectionId, !shown);
							},
						},
					],
	};
};

/**
 * Secrets in the source (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * setting them up, or, once they are, unlocking and the rest. Only where the
 * source syncs, since the key file is in its folder, and not while a first
 * import holds it, as the clipboard is not.
 */
export const useSecretsItem = (
	database: NotesDatabase,
	bound: SyncStateRecord,
	phase: SchedulerStatus['phase'],
	onChoose: () => void
): OptionsMenuItem[] => {
	const connectionId = bound.connectionId;
	const read = useLiveQuery(
		async () => ({ record: await database.keyFiles.get(connectionId) }),
		[database, connectionId]
	);
	return read === undefined || importingHere(bound) || phase === 'local'
		? []
		: [{ label: secretsLabel(read.record), onChoose }];
};
