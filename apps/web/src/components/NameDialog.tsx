import { useState } from 'react';

import { Dialog, DialogActions } from './Dialog.js';

/**
 * A name the app has to have before it can go on, asked over everything: a
 * scratch note's, before it is moved into a notebook (docs/ARCHITECTURE.md §7,
 * "The scratchpad"). A note in a notebook is known by its name, and one moved
 * there unnamed would be one more "Untitled" in the list.
 *
 * A `Dialog`, with the field taking the focus, since typing is the answer. The
 * answer is offered only once there is a name to give, and is handed back
 * trimmed.
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
	const [name, setName] = useState('');
	const given = name.trim();

	return (
		<Dialog
			title={title}
			text={text}
			onClose={onCancel}
			onSubmit={() => {
				if (given !== '') onConfirm(given);
			}}
		>
			<input
				className="name-field"
				aria-label={label}
				placeholder={label}
				value={name}
				onChange={(event) => {
					setName(event.target.value);
				}}
			/>
			<DialogActions
				primary={
					<button type="submit" className="primary" disabled={given === ''}>
						{confirmLabel}
					</button>
				}
			/>
		</Dialog>
	);
};
