/** What a toast is about, which decides both how it reads and how it announces. */
export type ToastTone = 'alert' | 'status';

export interface ToastProps {
	/** What happened, in the user's words. */
	message: string;
	tone: ToastTone;
	onDismiss: () => void;
}

/**
 * News of something that has just happened, over the shell rather than above
 * it, with a way to put it away.
 *
 * These were a bar across the top of the frame until 2026-09-21, which is
 * where the eye is not: connecting an account with the files permission
 * unticked said so in a thin grey strip over the sidebar, and it was read only
 * after being looked for. A card over the page is the same words where they
 * are seen.
 *
 * **No clock.** Every message that comes through here either asks the user to
 * do something — "Connect again and leave that permission ticked" — or names a
 * note they may want to go and find, and a notice that times out while it is
 * being read is the fault this is fixing rather than the fix. It goes when it
 * is dismissed, or when the user does anything else, which `select` has always
 * done for these. That also keeps it clear of WCAG 2.2.1: there is no time
 * limit to adjust.
 *
 * `role` follows the message and not the component. An alert interrupts a
 * screen reader where a status waits its turn, and "storage connected" is not
 * worth interrupting anyone for. Neither takes focus: the user is already
 * doing the next thing, and the button is in the tab order for whoever wants
 * it.
 */
export const Toast = ({ message, tone, onDismiss }: ToastProps) => (
	<div className={tone === 'alert' ? 'toast toast-alert' : 'toast'} role={tone}>
		<span>{message}</span>
		<button type="button" className="ghost" onClick={onDismiss}>
			Dismiss
		</button>
	</div>
);
