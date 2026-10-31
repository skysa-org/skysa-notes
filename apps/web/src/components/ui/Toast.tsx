import { useRef } from 'react';

import { t } from '../../i18n/t.js';
import { Icon } from './icons.js';
import { usePressAway } from './usePressAway.js';

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

/**
 * Somewhere to go about it. A link out, to a page the operator named (the
 * connect gate's action, `@skysa/core`'s `ConnectGate`): only ever an `https:`
 * URL the client has already checked (`api/client.ts`). Or what the app can
 * open for it where it is, as a button: the source's Vault dialog, for a
 * secret this device cannot open yet (`noteSecrets.tsx`). A link leaves the
 * toast to come back to; the button takes it away, since what it said is being
 * seen to.
 */
export type ToastAction =
	Readonly<{ label: string; url: string }> | Readonly<{ label: string; onChoose: () => void }>;

export interface ToastProps {
	/** What happened, in the user's words. */
	message: string;
	tone: ToastTone;
	/** What the user can do about it somewhere else, when there is something. */
	action?: ToastAction | undefined;
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
 * note about a notebook the user has since moved on from is clutter. Not a
 * touch in a dialog over the page (#443, 2026-10-25): that answers the
 * dialog, and the toast is still to be read once the dialog has gone. Pointers
 * only, deliberately — a keystroke in the editor does not take it away, so an
 * error can be read with the cursor still in the text it is about.
 *
 * The undo notice goes the same way (`DeletedNotice`, 2026-10-14), and keeps a
 * clock as well.
 */
export const Toast = ({ message, tone, action, onDismiss }: ToastProps) => {
	const card = useRef<HTMLDivElement>(null);

	// Not our own Dismiss, not a word being selected in the message, and not a
	// press in a dialog over the page (#443): what is pressed there answers the
	// dialog, and the toast is still to be read once it has gone.
	usePressAway(
		[card],
		() => {
			onDismiss();
		},
		{ ignoreModals: true }
	);

	return (
		<div ref={card} className={`surface-card toast toast-${tone}`} role={ROLE[tone]}>
			<span>{message}</span>
			{action !== undefined && 'url' in action && (
				// In this window, as connecting storage is: a new one, in an app
				// installed on a phone, had no way back but closing the app. The
				// operator's page links back (`?enter=code`). `noreferrer` so it is
				// not told where from.
				<a href={action.url} rel="noreferrer">
					{action.label}
				</a>
			)}
			{action !== undefined && 'onChoose' in action && (
				<button
					type="button"
					onClick={() => {
						onDismiss();
						action.onChoose();
					}}
				>
					{action.label}
				</button>
			)}
			<DismissButton onDismiss={onDismiss} />
		</div>
	);
};

/**
 * A notice's way out: an × in its corner (`.toast-close`). A Dismiss button of
 * the same weight beside Undo, or beside a link, competed with the one thing
 * the notice offers to do.
 */
export const DismissButton = ({ onDismiss }: { onDismiss: () => void }) => (
	<button
		type="button"
		className="icon icon-quiet toast-close"
		aria-label={t('common.dismiss')}
		onClick={onDismiss}
	>
		<Icon name="close" />
	</button>
);
