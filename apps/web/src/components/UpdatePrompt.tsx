import { useRegisterSW } from 'virtual:pwa-register/react';

import { t } from '../i18n/t.js';

/**
 * `registerType: 'prompt'` means a new build never swaps itself in underneath a
 * half-written note. The user decides when to reload.
 */
export const UpdatePrompt = () => {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW();

	if (!needRefresh) return null;

	return (
		<div className="update-prompt" role="status">
			<span>{t('shell.update.available')}</span>
			<button type="button" onClick={() => void updateServiceWorker(true)}>
				{t('common.reload')}
			</button>
			<button type="button" className="ghost" onClick={() => setNeedRefresh(false)}>
				{t('common.later')}
			</button>
		</div>
	);
};
