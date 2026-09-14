import { useRegisterSW } from 'virtual:pwa-register/react';

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
			<span>A new version is available.</span>
			<button type="button" onClick={() => void updateServiceWorker(true)}>
				Reload
			</button>
			<button type="button" className="ghost" onClick={() => setNeedRefresh(false)}>
				Later
			</button>
		</div>
	);
};
