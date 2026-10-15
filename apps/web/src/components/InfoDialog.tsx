import type { ReactNode, RefObject } from 'react';

import { t } from '../i18n/t.js';
import { Dialog, DialogActions } from './Dialog.js';

/**
 * Something the app has to say at more length than the place it is asked from
 * has room for, over everything, with Close: the devices signed in on a
 * source, and what its provider keeps from the app, asked for from the foot of
 * the sidebar (`AccountPanel`).
 *
 * A `Dialog` with nothing to answer: Close starts the row, and has the focus
 * unless what it holds has a field. What it holds may have controls of its own
 * — a device's Remove — and Tab goes between them too.
 */
export interface InfoDialogProps {
	title: string;
	children: ReactNode;
	onClose: () => void;
	/** What can be done about what it says, after Close. */
	actions?: ReactNode;
	/**
	 * Where the focus goes when the dialog does. Without it, back to whatever
	 * had it before, if that is still on the page.
	 */
	returnFocus?: RefObject<HTMLElement | null>;
}

export const InfoDialog = ({ title, children, onClose, actions, returnFocus }: InfoDialogProps) => (
	<Dialog
		title={title}
		className="info-dialog"
		onClose={onClose}
		closeLabel={t('common.close')}
		returnFocus={returnFocus}
	>
		{children}
		<DialogActions>{actions}</DialogActions>
	</Dialog>
);
