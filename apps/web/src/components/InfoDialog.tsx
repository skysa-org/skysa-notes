import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { t } from '../i18n/t.js';

/**
 * Something the app has to say at more length than the place it is asked from
 * has room for, over everything, with Close: the devices signed in on a
 * source, and what its provider keeps from the app, asked for from the foot of
 * the sidebar (`AccountPanel`).
 *
 * A `ConfirmDialog` with nothing to confirm, and built as it is, for its
 * reasons: at the end of the page, so no stacking context below it can put it
 * under the toasts; modal, so Tab stays inside it and the shortcuts are held;
 * Escape is Close; and the focus goes back where it came from. What it holds
 * may have controls of its own — a device's Remove — so Tab goes between every
 * button and link in it, not only Close.
 */
export interface InfoDialogProps {
	title: string;
	children: ReactNode;
	onClose: () => void;
	/**
	 * Where the focus goes when the dialog does. Without it, back to whatever
	 * had it before, if that is still on the page.
	 */
	returnFocus?: RefObject<HTMLElement | null>;
}

const REACHABLE = 'button:not(:disabled), a[href]';

export const InfoDialog = ({ title, children, onClose, returnFocus }: InfoDialogProps) => {
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	useSuspendShortcuts();

	useEffect(() => {
		// Read now: what it names is on the page for as long as the dialog is.
		const back = returnFocus?.current ?? document.activeElement;
		close.current?.focus();
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is taken once and given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const reachable = [...element.querySelectorAll<HTMLElement>(REACHABLE)];
			const at = reachable.indexOf(document.activeElement as HTMLElement);
			const next = (at + (event.shiftKey ? -1 : 1) + reachable.length) % reachable.length;
			event.preventDefault();
			reachable[next]?.focus();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [onClose]);

	return createPortal(
		<div className="modal-backdrop">
			<div
				ref={dialog}
				className="modal info-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
			>
				<h2 id={titleId}>{title}</h2>
				{children}
				<div className="modal-actions">
					<button ref={close} type="button" onClick={onClose}>
						{t('common.close')}
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};
