import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { DismissButton } from './ui/Toast.js';

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
	 * copy of text the store never took, and neither a clock nor a click
	 * somewhere else must be what loses it.
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
 *
 * It also goes as soon as the user presses anywhere else on the page, as a
 * toast does (`Toast`; 2026-10-14, the owner's call). It stood until then on
 * the reasoning that a click elsewhere should not take away the way back, and
 * in practice it sat over the page after the user had moved on. Pointers only,
 * as there: a key pressed elsewhere is how a keyboard reaches the Undo button
 * at all, by tabbing to it. A notice that `keep`s is the exception, since what
 * it holds may be text that is nowhere else.
 */
export const DeletedNotice = ({ title, onUndo, onDismiss, keep = false }: DeletedNoticeProps) => {
	const card = useRef<HTMLDivElement>(null);
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
	useEffect(() => {
		if (keep) return undefined;
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && card.current?.contains(target) === true) return;
			// Nor a press in a dialog over the page, which is not the page: the
			// command palette offers this same Undo, and choosing it there by
			// pointer would otherwise take it away before the click arrived.
			if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) {
				return;
			}
			onDismiss();
		};
		// From an effect, as `Toast` does: by the time it listens, the press that
		// deleted the note has finished dispatching and cannot take this away.
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [keep, onDismiss]);

	return (
		<div
			ref={card}
			className="toast"
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
			<span>{t('shell.deleted.text', { title })}</span>
			<button type="button" onClick={onUndo}>
				{t('shell.deleted.undo')}
			</button>
			<DismissButton onDismiss={onDismiss} />
		</div>
	);
};
