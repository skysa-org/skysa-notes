import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { t } from '../../i18n/t.js';
import { subscribeTabState, tabState } from '../../store/staleTab.js';
import { Dialog, DialogActions } from '../ui/Dialog.js';

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
 *
 * The notice is a `Dialog` with no way out — no Cancel, no Escape — since
 * neither answer can be put off; Reload is the answer, and has the focus.
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

	return (
		<>
			<div className="tab-gate" inert={blocked}>
				{children}
			</div>
			{state === 'stale' && copying && (
				<div className="update-prompt tab-stale-bar" role="alert">
					<span>{t('shell.staleTab.cannotSave')}</span>
					<button type="button" onClick={reload}>
						{t('common.reload')}
					</button>
				</div>
			)}
			{blocked && (
				<Dialog
					title={t('shell.staleTab.title')}
					text={t('shell.staleTab.text')}
					role="alertdialog"
				>
					<DialogActions
						primary={
							<button type="button" className="primary" onClick={reload}>
								{t('common.reload')}
							</button>
						}
					>
						<button
							type="button"
							onClick={() => {
								setCopying(true);
							}}
						>
							{t('shell.staleTab.copyFirst')}
						</button>
					</DialogActions>
				</Dialog>
			)}
			{state === 'waiting' && (
				<div className="update-prompt" role="status">
					<span>{t('shell.staleTab.waiting')}</span>
				</div>
			)}
		</>
	);
};
