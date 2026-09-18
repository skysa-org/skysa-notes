import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';

import { subscribeTabState, tabState } from '../store/staleTab.js';

/**
 * The app, and in front of it the two things `store/staleTab.ts` can have to
 * say. Separate from `UpdatePrompt`, which offers a new build the user may
 * decline: neither of these can be put off, because in both the store under the
 * app is not there to read or write.
 *
 * Out of date blocks rather than asks. The connection is closed for good, so
 * every save from here on fails, and an editor that still took typing would be
 * taking words it cannot keep. The app underneath is made inert rather than
 * unmounted, so what was on screen can still be read behind the notice. Held
 * edits were flushed before the connection closed (`beforeClosing`); inert also
 * stops selection in most browsers, so anything that flush missed can be read
 * off the page but not copied from it.
 */
export const StaleTabGate = ({
	children,
	reload = () => {
		window.location.reload();
	},
}: {
	children: ReactNode;
	/** Injected for the same reason as `AccountPanel`'s `navigate`: jsdom has no navigation. */
	reload?: () => void;
}) => {
	const state = useSyncExternalStore(subscribeTabState, tabState);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (state === 'stale') button.current?.focus();
	}, [state]);

	return (
		<>
			<div className="tab-gate" inert={state === 'stale'}>
				{children}
			</div>
			{state === 'stale' && (
				<div className="tab-notice-backdrop">
					<div
						className="tab-notice"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="tab-notice-title"
						aria-describedby="tab-notice-text"
					>
						<h2 id="tab-notice-title">This tab is out of date</h2>
						<p id="tab-notice-text">
							A newer version of the app is open in another tab, and this one can no
							longer save. Reload to carry on here.
						</p>
						<button ref={button} type="button" onClick={reload}>
							Reload
						</button>
					</div>
				</div>
			)}
			{state === 'waiting' && (
				<div className="update-prompt" role="status">
					<span>
						Waiting for an older tab of this app to finish. If this does not go away,
						close the other tabs.
					</span>
				</div>
			)}
		</>
	);
};
