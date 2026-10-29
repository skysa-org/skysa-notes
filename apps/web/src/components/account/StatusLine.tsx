import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../editor/icons.js';
import { t } from '../../i18n/t.js';
import { type SchedulerStatus } from '../../sync/scheduler.js';
import { InfoDialog } from '../InfoDialog.js';
import { OptionsMenu, type OptionsMenuItem } from '../OptionsMenu.js';
import { RunProgress } from '../RunProgress.js';
import { type AccountSlot } from '../SourceTabs.js';
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
 * The panel's actions as one `⋯` menu, drawn into the end of the showing
 * source's row as every other row's is drawn into its own (`RowOptions`, whose
 * names it takes). There with nothing in it too, disabled, so the rows keep
 * their shape from source to source.
 */
export const ActionsMenu = ({
	slot,
	items,
	triggerRef,
	onOpen,
}: {
	slot: AccountSlot;
	items: readonly OptionsMenuItem[];
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onOpen?: () => void;
}) => {
	// First, as a notebook's menu has it: what the source is called, then what
	// can be done with it.
	const all =
		slot.onRename === undefined
			? items
			: [{ label: t('account.menu.rename'), onChoose: slot.onRename }, ...items];
	return slot.menuIn === null
		? null
		: createPortal(
				<OptionsMenu
					label={t('account.menu.sourceLabel', { name: slot.name })}
					title={t('account.menu.sourceTitle')}
					groupLabel={t('account.menu.sourceGroup', { name: slot.name })}
					triggerClassName="icon icon-quiet"
					trigger={<Icon name="overflow" />}
					disabled={all.length === 0}
					items={all}
					{...(triggerRef === undefined ? {} : { triggerRef })}
					{...(onOpen === undefined ? {} : { onOpen })}
				/>,
				slot.menuIn
			);
};

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

/**
 * The panel's actions, behind a gear at the end of its status line: what the
 * showing source's `⋯` offers in a compact window's source dropdown, from the
 * same lists. It opens upwards, being at the foot of the window.
 */
export const GearMenu = ({
	items,
	triggerRef,
	onOpen,
}: {
	items: readonly OptionsMenuItem[];
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onOpen?: () => void;
}) => (
	<OptionsMenu
		label={t('account.menu.label')}
		title={t('account.menu.label')}
		groupLabel={t('account.menu.group')}
		triggerClassName="icon icon-quiet"
		trigger={<Icon name="gear" />}
		disabled={items.length === 0}
		items={items}
		rises
		{...(triggerRef === undefined ? {} : { triggerRef })}
		{...(onOpen === undefined ? {} : { onOpen })}
	/>
);

/**
 * The gear and, in a compact window, the source's `⋯` — two menus of one
 * list — and `openButton` kept on the one opened last, which is where the
 * focus goes back to once a question asked from it is put away. The gear,
 * until either is opened. Each has its own ref: a menu's button is also where
 * it is anchored, so the two cannot share one.
 */
export const useMenuButtons = (openButtonRef: RefObject<HTMLButtonElement | null>) => {
	const gear = useRef<HTMLButtonElement>(null);
	const dots = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		openButtonRef.current ??= gear.current;
	});
	const onGear = useCallback(() => {
		openButtonRef.current = gear.current;
	}, [openButtonRef]);
	const onDots = useCallback(() => {
		openButtonRef.current = dots.current;
	}, [openButtonRef]);
	return { gear, dots, onGear, onDots };
};
