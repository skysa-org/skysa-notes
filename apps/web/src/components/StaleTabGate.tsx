import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
 * unmounted, so what was on screen can still be read behind the notice.
 *
 * Inert also stops selection, and that is the one thing the block must not cost.
 * Held edits were flushed before the connection closed (`beforeClosing`), but a
 * flush can fail — and a tab whose saves were already failing has been telling
 * its user to copy their text somewhere safe. So the notice can be put aside
 * for that: the app comes back, selectable, under a bar that goes on saying it
 * cannot save. Typing there is refused by the store and said by the note view.
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
	const [copying, setCopying] = useState(false);
	const blocked = state === 'stale' && !copying;
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (blocked) button.current?.focus();
	}, [blocked]);

	return (
		<>
			<div className="tab-gate" inert={blocked}>
				{children}
			</div>
			{state === 'stale' && copying && (
				<div className="update-prompt tab-stale-bar" role="alert">
					<span>
						This tab is out of date and cannot save. Copy what you need, then reload.
					</span>
					<button type="button" onClick={reload}>
						Reload
					</button>
				</div>
			)}
			{blocked && (
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
						<div className="tab-notice-actions">
							<button ref={button} type="button" onClick={reload}>
								Reload
							</button>
							<button
								type="button"
								onClick={() => {
									setCopying(true);
								}}
							>
								Copy my text first
							</button>
						</div>
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
