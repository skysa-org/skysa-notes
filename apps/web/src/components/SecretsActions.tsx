import { createContext, type ReactNode, useContext } from 'react';

/**
 * The way out of the secrets dialog a step is in, and what is under way there,
 * handed by `SecretsModal` to the step's last row.
 */
export interface Closing {
	readonly label: string;
	readonly onClose: () => void;
	/** What is under way, said above the row. */
	readonly status?: string | undefined;
}

export const ClosingContext = createContext<Closing | undefined>(undefined);

/**
 * A step's buttons, and the dialog's own Cancel or Close after them, in one
 * row, as the app's other dialogs have theirs (`ConfirmDialog`). Every step of
 * a secrets dialog ends in one. A step with a Cancel of its own, which goes
 * back rather than out, leaves the dialog's off (`close={false}`).
 */
export const SecretsActions = ({
	children,
	close = true,
}: {
	children?: ReactNode;
	close?: boolean;
}) => {
	const closing = useContext(ClosingContext);
	return (
		<>
			{closing?.status !== undefined && (
				<p className="secrets-said" role="status">
					{closing.status}
				</p>
			)}
			<div className="modal-actions">
				{children}
				{close && closing !== undefined && (
					<button type="button" onClick={closing.onClose}>
						{closing.label}
					</button>
				)}
			</div>
		</>
	);
};
