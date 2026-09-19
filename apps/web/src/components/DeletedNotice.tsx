import { useEffect, useRef, useState } from 'react';

/**
 * How long a delete can be taken back from here. Long enough to notice the note
 * has gone and reach for the button; after it the note is still only as deleted
 * as sync has made it, but nothing on screen offers it back.
 */
export const UNDO_WINDOW_MS = 10_000;

/** How soon after a touch a `mouseenter` is the touch's own, and not a mouse. */
const TOUCH_ECHO_MS = 1000;

export interface DeletedNoticeProps {
	title: string;
	onUndo: () => void;
	onDismiss: () => void;
	/**
	 * Stay until dismissed. For an undo that failed: the notice may hold the only
	 * copy of text the store never took, and a clock must not be what loses it.
	 */
	keep?: boolean;
}

/**
 * "Deleted", with the way back. Deleting is one click and asks nothing first,
 * so this is the whole of its safety.
 *
 * A status, not an alert, and it takes no focus: the user deleted the note on
 * purpose and is already doing the next thing. It is in the tab order for
 * whoever wants it, and the clock stops while it holds the pointer or the
 * focus — a button that vanishes as it is reached for is worse than none.
 *
 * The two are kept apart, since either can end while the other goes on: focus
 * tabbing out must not start the clock under a pointer still resting there. And
 * a touch is not a pointer resting anywhere — it sends a `mouseenter` and never
 * the `mouseleave`, which held the notice up for good.
 */
export const DeletedNotice = ({ title, onUndo, onDismiss, keep = false }: DeletedNoticeProps) => {
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const touchedAt = useRef(0);
	const held = keep || hovered || focused;
	useEffect(() => {
		if (held) return undefined;
		const timer = setTimeout(onDismiss, UNDO_WINDOW_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [held, onDismiss]);

	return (
		<div
			className="update-prompt deleted-notice"
			role="status"
			onTouchStart={() => {
				touchedAt.current = Date.now();
			}}
			onMouseEnter={() => {
				// The one a touch sends follows it at once; a mouse on the same
				// device, later, is a pointer that does rest here.
				if (Date.now() - touchedAt.current > TOUCH_ECHO_MS) setHovered(true);
			}}
			onMouseLeave={() => {
				setHovered(false);
			}}
			onFocus={() => {
				setFocused(true);
			}}
			onBlur={() => {
				setFocused(false);
			}}
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
