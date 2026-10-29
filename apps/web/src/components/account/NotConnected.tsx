import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useSyncExternalStore } from 'react';

import { answer } from '../../api/instanceConfig.js';
import type { pickFiles } from '../../editor/pickFiles.js';
import { t } from '../../i18n/t.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { holdsAnything, type Library } from '../../store/exportNotes.js';
import type { Keeping } from '../../store/keeping.js';
import { CONNECTABLE } from '../../sync/account.js';
import { importItems, ImportNotes, useImportNotes } from '../ImportNotes.js';
import type { LocalProps } from './clients.js';
import { DownloadAll, downloadItem, useDownloadAll } from './DownloadAll.js';
import { ActionsMenu, GearMenu } from './PanelMenus.js';
import { StatusLine } from './StatusLine.js';
import { useScratchpadItem } from './storageItems.js';
import { useAsked } from './useAsked.js';

/**
 * What the browser has said about keeping this device's notes, asked on sight
 * — `persisted()` never prompts — and followed as it changes, since the request
 * that changes it is made from somewhere else (a note being created).
 *
 * Asked again whenever the tab comes back into view: the answer can change
 * where this tab cannot hear it, in another tab's request or in the browser's
 * own site settings.
 */
const useKept = (keep: Keeping) => {
	const kept = useSyncExternalStore(keep.subscribe, keep.state);
	useEffect(() => {
		void keep.check();
		const shown = () => {
			if (document.visibilityState === 'visible') void keep.check();
		};
		document.addEventListener('visibilitychange', shown);
		return () => {
			document.removeEventListener('visibilitychange', shown);
		};
	}, [keep]);
	return kept;
};

export const NotConnected = ({
	config,
	database,
	downloadAll,
	keep,
	slot,
	pick,
}: LocalProps & {
	downloadAll: (library: Library) => void;
	keep: Keeping;
	pick: typeof pickFiles | undefined;
}) => {
	const settings = answer(config);
	const holds = useLiveQuery(() => holdsAnything(database, LOCAL_CONNECTION_ID), [database]);
	const downloading = useDownloadAll(database, LOCAL_CONNECTION_ID, downloadAll);
	const importing = useImportNotes(database, LOCAL_CONNECTION_ID, {
		label: t('account.thisDevice'),
		syncs: false,
		...(pick === undefined ? {} : { pick }),
	});
	useAsked(slot, LOCAL_CONNECTION_ID, (action) => {
		if (action !== 'download') return true;
		if (holds === undefined) return false;
		if (holds) downloading.start();
		return true;
	});
	const kept = useKept(keep);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];
	const scratchpad = useScratchpadItem(database, LOCAL_CONNECTION_ID);
	const items = [
		...downloadItem(holds, downloading),
		...importItems(importing, { scratchpad: scratchpad.shown === true }),
		...scratchpad.items,
	];

	return (
		<section className="account" aria-label={t('account.region')}>
			{/* Where the notes are is said by the status line. The way to
			    connect is beside it in the bar above, in words, at the foot of
			    the sidebar; in a compact window's source dropdown it is the `+`
			    in its header, which never has words, so it is said here. */}
			{slot !== undefined && offerable.length > 0 && (
				<p className="muted">{t('account.local.useAdd')}</p>
			)}
			{settings?.authMode === 'account-first' && (
				<p className="muted">{t('account.local.signInMissing')}</p>
			)}
			{config.kind === 'unreachable' && (
				<p className="muted">{t('account.local.unreachable')}</p>
			)}
			{/*
			 * The one place the notes here are all there is, so the one place it
			 * is said. Not before the browser has answered, and not once it has
			 * said it will keep them. What helps is connecting, which makes a
			 * second copy, and the button below, which makes one now.
			 *
			 * Not installing, though the app asks again when it is installed.
			 * It is advice that holds only in Chromium: Firefox on a desktop has
			 * nothing to install, and in Safari a Home Screen app keeps its data
			 * apart from Safari's, so the installed app opens empty and the
			 * notes stay where they were (docs/ARCHITECTURE.md §8).
			 */}
			{holds === true && kept === 'not-kept' && (
				<p className="muted">{t('account.local.mayClear')}</p>
			)}
			<DownloadAll holds={holds} downloading={downloading} />
			<ImportNotes importing={importing} />
			<StatusLine text={t('account.local.line')} title={null}>
				<GearMenu items={items} />
			</StatusLine>
			{slot !== undefined && <ActionsMenu slot={slot} items={items} />}
		</section>
	);
};
