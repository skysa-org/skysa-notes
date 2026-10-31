import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { t } from '../../i18n/t.js';
import { makeWay, updateChannel } from '../../sync/beforeUpdate.js';
import { syncScheduler } from '../../sync/runtime.js';

/** How long Reload may go unanswered before the prompt says what else to do. */
const SLOW_MS = 10_000;

/**
 * `registerType: 'prompt'` means a new build never swaps itself in underneath a
 * half-written note. The user decides when to reload.
 *
 * Reload stops the app's requests first (`sync/beforeUpdate.ts`): asked while
 * a sync was going, the new build waited minutes to take over, and the button
 * looked dead. It says it is updating meanwhile, and if the page has still not
 * reloaded after `SLOW_MS`, what else will do it.
 */
export const UpdatePrompt = ({
	beforeUpdate = () => makeWay(syncScheduler, updateChannel()),
	slowAfter = SLOW_MS,
}: {
	/** Injected: a test has no sync to pause and no other tab to tell. */
	beforeUpdate?: () => Promise<void>;
	slowAfter?: number;
}) => {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW();
	const [updating, setUpdating] = useState<'no' | 'asked' | 'slow'>('no');

	useEffect(() => {
		if (updating !== 'asked') return undefined;
		const timer = setTimeout(() => {
			setUpdating('slow');
		}, slowAfter);
		return () => {
			clearTimeout(timer);
		};
	}, [updating, slowAfter]);

	if (!needRefresh) return null;

	if (updating !== 'no') {
		return (
			<div className="update-prompt" role="status">
				<span>
					{updating === 'slow' ? t('shell.update.slow') : t('shell.update.updating')}
				</span>
			</div>
		);
	}

	return (
		<div className="update-prompt" role="status">
			<span>{t('shell.update.available')}</span>
			<button
				type="button"
				onClick={() => {
					setUpdating('asked');
					void beforeUpdate().then(() => updateServiceWorker(true));
				}}
			>
				{t('common.reload')}
			</button>
			<button type="button" className="ghost" onClick={() => setNeedRefresh(false)}>
				{t('common.later')}
			</button>
		</div>
	);
};
