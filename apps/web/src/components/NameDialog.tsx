import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { t } from '../i18n/t.js';

/**
 * A name the app has to have before it can go on, asked over everything: a
 * scratch note's, before it is moved into a notebook (docs/ARCHITECTURE.md §7,
 * "The scratchpad"). A note in a notebook is known by its name, and one moved
 * there unnamed would be one more "Untitled" in the list.
 *
 * Drawn and held as `ConfirmDialog` is — at the end of the page, the shortcuts
 * held, Escape as Cancel — with the field taking the focus, since typing is
 * the answer. The answer is offered only once there is a name to give, and is
 * handed back trimmed. Tab stays inside it.
 */
export interface NameDialogProps {
	title: string;
	/** What the name is for, under the title. */
	text: string;
	/** What the field is called, for a screen reader and as its placeholder. */
	label: string;
	confirmLabel: string;
	onConfirm: (name: string) => void;
	onCancel: () => void;
}

export const NameDialog = ({
	title,
	text,
	label,
	confirmLabel,
	onConfirm,
	onCancel,
}: NameDialogProps) => {
	const titleId = useId();
	const textId = useId();
	const dialog = useRef<HTMLFormElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const [name, setName] = useState('');
	useSuspendShortcuts();

	useEffect(() => {
		const back = document.activeElement;
		field.current?.focus();
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
	}, []);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== 'Tab') return;
			const stops = [
				...element.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
			];
			const at = stops.indexOf(document.activeElement as HTMLElement);
			const next = (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
			event.preventDefault();
			stops[next]?.focus();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [onCancel]);

	const given = name.trim();

	return createPortal(
		<div className="modal-backdrop">
			<form
				ref={dialog}
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={textId}
				onSubmit={(event) => {
					event.preventDefault();
					if (given !== '') onConfirm(given);
				}}
			>
				<h2 id={titleId}>{title}</h2>
				<p id={textId}>{text}</p>
				<input
					ref={field}
					className="name-field"
					aria-label={label}
					placeholder={label}
					value={name}
					onChange={(event) => {
						setName(event.target.value);
					}}
				/>
				<div className="modal-actions">
					<button type="submit" className="primary" disabled={given === ''}>
						{confirmLabel}
					</button>
					<button type="button" onClick={onCancel}>
						{t('common.cancel')}
					</button>
				</div>
			</form>
		</div>,
		document.body
	);
};
