import { useEffect, useState } from 'react';

/**
 * How long a delete can be taken back from here. Long enough to notice the note
 * has gone and reach for the button; after it the note is still only as deleted
 * as sync has made it, but nothing on screen offers it back.
 */
export const UNDO_WINDOW_MS = 10_000;

export interface DeletedNoticeProps {
	title: string;
	onUndo: () => void;
	onDismiss: () => void;
}

/**
 * "Deleted", with the way back. Deleting is one click and asks nothing first,
 * so this is the whole of its safety.
 *
 * A status, not an alert, and it takes no focus: the user deleted the note on
 * purpose and is already doing the next thing. It is in the tab order for
 * whoever wants it, and the clock stops while it holds the pointer or the
 * focus — a button that vanishes as it is reached for is worse than none.
 */
export const DeletedNotice = ({ title, onUndo, onDismiss }: DeletedNoticeProps) => {
	const [held, setHeld] = useState(false);
	useEffect(() => {
		if (held) return undefined;
		const timer = setTimeout(onDismiss, UNDO_WINDOW_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [held, onDismiss]);

	const hold = () => {
		setHeld(true);
	};
	const release = () => {
		setHeld(false);
	};

	return (
		<div
			className="update-prompt deleted-notice"
			role="status"
			onMouseEnter={hold}
			onMouseLeave={release}
			onFocus={hold}
			onBlur={release}
		>
			<span>Deleted “{title}”.</span>
			<button type="button" onClick={onUndo}>
				Undo
			</button>
			<button type="button" className="ghost" onClick={onDismiss}>
				Dismiss
			</button>
		</div>
	);
};
