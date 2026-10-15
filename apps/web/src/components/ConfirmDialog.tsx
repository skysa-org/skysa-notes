import type { ReactNode, RefObject } from 'react';

import { Dialog, DialogActions } from './Dialog.js';

/**
 * A question the app asks over everything, with one answer and Cancel, or two
 * where they are alike (`also`). Built as every dialog is (`Dialog`): Cancel
 * first and the answer last, the answer with the focus — Enter answers — and
 * Escape is Cancel.
 *
 * `tone` is how the answer is drawn: `primary` for the one the question
 * expects, `danger` for one that deletes.
 */
export interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	tone: 'primary' | 'danger';
	onConfirm: () => void;
	onCancel: () => void;
	/** A second answer, before the first and drawn plainly: "Choose files", then "Choose folder". */
	also?: { label: string; onChoose: () => void };
	/**
	 * Where the focus goes when the dialog does. Without it, back to whatever
	 * had it before, if that is still on the page.
	 */
	returnFocus?: RefObject<HTMLElement | null>;
}

export const ConfirmDialog = ({
	title,
	children,
	confirmLabel,
	tone,
	onConfirm,
	onCancel,
	also,
	returnFocus,
}: ConfirmDialogProps) => (
	<Dialog
		title={title}
		text={children}
		role="alertdialog"
		onClose={onCancel}
		returnFocus={returnFocus}
	>
		<DialogActions
			primary={
				<button type="button" className={tone} onClick={onConfirm}>
					{confirmLabel}
				</button>
			}
		>
			{also !== undefined && (
				<button type="button" onClick={also.onChoose}>
					{also.label}
				</button>
			)}
		</DialogActions>
	</Dialog>
);
