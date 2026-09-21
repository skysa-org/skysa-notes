import { useEffect, useRef } from 'react';

/**
 * What a toast is about. It decides the colour, the weight of the words, and
 * how the message announces.
 *
 * Three and not four: there is no neutral "info" tone, because everything that
 * reaches a toast here is the outcome of something the user just did. The undo
 * notice, which is the one card with no outcome to report, carries no tone at
 * all.
 */
export type ToastTone = 'success' | 'warning' | 'error';

/**
 * An error and a warning interrupt a screen reader; a success waits its turn.
 * The role follows the message rather than the component, which is why it is a
 * table here and not a prop: "storage connected" is not worth interrupting
 * anyone for, and a caller should not be able to decide otherwise by accident.
 */
const ROLE: Record<ToastTone, 'alert' | 'status'> = {
	success: 'status',
	warning: 'alert',
	error: 'alert',
};

export interface ToastProps {
	/** What happened, in the user's words. */
	message: string;
	tone: ToastTone;
	/**
	 * Stable across renders: it is a dependency of the listener below, and an
	 * arrow made fresh each time would tear that down and rebuild it on every
	 * keystroke in the note.
	 */
	onDismiss: () => void;
}

/**
 * News of something that has just happened, over the shell rather than above
 * it, with three ways out of it.
 *
 * These were a bar across the top of the frame until 2026-09-21, which is
 * where the eye is not: connecting an account with the files permission
 * unticked said so in a thin grey strip over the sidebar, and it was read only
 * after being looked for.
 *
 * **No timer.** Every message that comes through here either asks the user to
 * do something — "Connect again and leave that permission ticked" — or names a
 * note they may want to go and find, and a notice that vanishes on a clock
 * while it is being read is the fault this is fixing rather than the fix. It
 * goes when it is dismissed, when the user touches anything else, or when they
 * navigate (`select`). None of those is a time limit, so WCAG 2.2.1 has
 * nothing to be about.
 *
 * Touching anything else counts because a toast reports on a thing that is
 * over: reading it *is* acknowledging it, and a card left sitting over the
 * note about a notebook the user has since moved on from is clutter. Pointers
 * only, deliberately — a keystroke in the editor does not take it away, so an
 * error can be read with the cursor still in the text it is about.
 *
 * The undo notice does **not** do this, and the difference is the point: a
 * click anywhere taking away the only route back from a delete would lose
 * work. It keeps its own clock, which stops while it is hovered or focused.
 */
export const Toast = ({ message, tone, onDismiss }: ToastProps) => {
	const card = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			// Not our own Dismiss, and not a word being selected in the message.
			const target = event.target;
			if (target instanceof Node && card.current?.contains(target) === true) return;
			onDismiss();
		};
		// `pointerdown`, so a press anywhere answers without waiting to see
		// whether it becomes a click; and attached from an effect, so that by the
		// time it is listening the interaction that put this toast here has
		// finished dispatching and cannot be the one that takes it away again.
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [onDismiss]);

	return (
		<div ref={card} className={`toast toast-${tone}`} role={ROLE[tone]}>
			<span>{message}</span>
			<button type="button" className="ghost" onClick={onDismiss}>
				Dismiss
			</button>
		</div>
	);
};
