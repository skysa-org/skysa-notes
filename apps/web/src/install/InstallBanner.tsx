import { useLiveQuery } from 'dexie-react-hooks';
import { useSyncExternalStore } from 'react';

import { useMediaQuery } from '../components/layout.js';
import { Icon } from '../editor/icons.js';
import { db as appDatabase, type NotesDatabase } from '../store/db.js';
import { dismissInstall, getInstallDismissed } from '../store/prefs.js';
import { type Device, type ManualInstall, manualInstall, thisDevice } from './installHow.js';
import { type InstallPrompt, installPrompt } from './installPrompt.js';

/**
 * An offer to install the app, across the top of it while it runs in a
 * browser tab (docs/ARCHITECTURE.md §8, "Installing from the browser"). Where
 * the browser can install it from the page (Chromium), it has an Install
 * button; where installing is a menu item of the browser's own (Safari, on an
 * iPhone, an iPad or a Mac), it says which. Nowhere else, since anything it
 * said there would be advice the browser cannot follow.
 *
 * Gone once the app is installed, or opened as an installed app, and for good
 * once dismissed: the dismissal is kept on this device (`dismissInstall`).
 */

export interface InstallBannerProps {
	database?: NotesDatabase;
	/** What the browser has said about installing. Injected for tests. */
	prompt?: InstallPrompt;
	/** Which browser this is, for one that has no install event. Injected for tests. */
	device?: Device;
	/** What the app is called. */
	name?: string;
}

const APP_NAME = import.meta.env.VITE_APP_NAME ?? 'this app';

const MANUAL: Readonly<Record<ManualInstall, (name: string) => string>> = {
	'home-screen': (name) => `Install ${name}: tap Share, then Add to Home Screen.`,
	dock: (name) => `Install ${name}: in Safari's File menu, choose Add to Dock.`,
};

export const InstallBanner = ({
	database = appDatabase,
	prompt = installPrompt,
	device = thisDevice(),
	name = APP_NAME,
}: InstallBannerProps) => {
	const dismissed = useLiveQuery(() => getInstallDismissed(database), [database]);
	// An installed app opens in a window of its own (`display: standalone` in
	// the manifest), and Chromium moves a tab into one as it installs.
	const inBrowser = useMediaQuery('(display-mode: browser)');
	const state = useSyncExternalStore(prompt.subscribe, prompt.state);

	if (dismissed !== false || !inBrowser || state.kind === 'installed') return null;
	const manual = state.kind === 'ready' ? undefined : manualInstall(device);
	if (state.kind !== 'ready' && manual === undefined) return null;

	return (
		<aside className="banner install-banner" aria-label={`Install ${name}`}>
			<span className="install-banner-text">
				{manual === undefined
					? `Install ${name} to open it in a window of its own, offline too.`
					: MANUAL[manual](name)}
			</span>
			{state.kind === 'ready' && (
				<button
					type="button"
					className="install-banner-install"
					onClick={() => {
						// Declined, the event is spent and the banner goes until the
						// browser offers the install again, but nothing is kept:
						// only the banner's own dismissal is for good.
						void state.install();
					}}
				>
					Install
				</button>
			)}
			<button
				type="button"
				className="icon icon-quiet"
				aria-label="Dismiss"
				title="Don't show this again"
				onClick={() => {
					void dismissInstall(database);
				}}
			>
				<Icon name="close" />
			</button>
		</aside>
	);
};
