import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { t } from '../i18n/t.js';

/**
 * Every dialog the app draws, built one way (docs/ARCHITECTURE.md §7,
 * "Dialogs"; the owner's rules, 2026-10-15):
 *
 * - The buttons are one row at the dialog's end (`DialogActions`): the way out
 *   first — Cancel while something is asked, Close once nothing is — and the
 *   answer last, with whatever else there is between.
 * - The focus starts on the first field, where something is typed or drawn,
 *   and otherwise on the answer. A step drawn in place of another takes it the
 *   same way.
 * - Escape is the way out, where there is one. A dialog that has to be
 *   answered has neither.
 *
 * `Dialog` is drawn over everything; `InlineDialog` is a question asked in
 * place, in a panel. Both hand the row its way out.
 *
 * Over everything means at the end of the page, rather than where it was
 * asked from: the `+` menu (z-index 20) and the compact source panel (15) are
 * each a stacking context, and a dialog inside either is only as high as they
 * are — under the toast stack (30), which it has to be over. `aria-modal`
 * says the rest of the page is out of reach, so Tab goes round what is in the
 * dialog and nowhere else, and the shortcuts are held while it is up: a chord
 * pressed out of habit would act on a page the user cannot get at.
 */

/** What the row is handed by the dialog it is in. */
interface Closing {
	readonly label: string;
	readonly onClose: () => void;
	/** What is under way, said over the row. */
	readonly status?: string | undefined;
	/** Something is under way that the way out would not stop: it waits. */
	readonly busy?: boolean | undefined;
}

const ClosingContext = createContext<Closing | undefined>(undefined);

/** What can take the focus, and so what Tab goes between. */
const REACHABLE = [
	'input:not(:disabled):not([type="hidden"])',
	'textarea:not(:disabled)',
	'select:not(:disabled)',
	'button:not(:disabled)',
	'a[href]',
	'[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Where something is typed, chosen or drawn: a field, or what stands for one. */
const FIELD = [
	'input:not(:disabled):not([type="hidden"])',
	'textarea:not(:disabled)',
	'select:not(:disabled)',
	'[data-dialog-field] button:not(:disabled)',
].join(', ');

const PRIMARY = '[data-dialog-primary] :is(button, input)';

/**
 * The first of `selector` that is the dialog's own, and not a question asked
 * in place inside it — a file's Delete in the dialog listing them.
 */
const own = (element: HTMLElement, selector: string): HTMLElement | null =>
	[...element.querySelectorAll<HTMLElement>(selector)].find(
		(found) => found.closest('[data-dialog]') === element
	) ?? null;

/**
 * Where the focus goes in a dialog as it opens, or as a step of it is drawn:
 * the first field; else the answer; else the way out; else whatever can take
 * it. With `wait`, an answer there but not to be given yet — a try under way —
 * is waited for, rather than the focus going on to the way out, where Enter
 * would leave. Whether it went anywhere.
 */
export const focusFirst = (element: HTMLElement, { wait = false } = {}): boolean => {
	const waiting = wait && own(element, PRIMARY) !== null;
	const target =
		own(element, FIELD) ??
		own(element, `${PRIMARY}:not(:disabled)`) ??
		(waiting
			? null
			: (own(element, '[data-dialog-close]') ??
				element.querySelector<HTMLElement>(REACHABLE)));
	target?.focus();
	return target !== null;
};

/**
 * A step drawn in place of another takes the focus as the dialog first did,
 * where the control that had it went with the step it was in, or can no longer
 * have it — an Unlock pressed, and so waiting. Only then: a press on the page
 * behind, or a status changing, leaves it where it is.
 */
const useRefocus = (dialog: RefObject<HTMLElement | null>): void => {
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const state: { focused: Element | null; owed: boolean } = { focused: null, owed: false };
		const onFocus = (event: FocusEvent) => {
			state.focused = event.target instanceof Element ? event.target : null;
		};
		// Taken somewhere else on purpose — a question asked in place, left for
		// the note beside it — the focus is not fetched back.
		const onBlur = (event: FocusEvent) => {
			const to = event.relatedTarget;
			if (to instanceof Node && !element.contains(to)) state.focused = null;
		};
		const observer = new MutationObserver(() => {
			const active = document.activeElement;
			const lost = !element.contains(active) || (active?.matches(':disabled') ?? false);
			if (!lost) {
				state.owed = false;
				return;
			}
			const had = state.focused;
			state.owed ||= had !== null && (!had.isConnected || had.matches(':disabled'));
			if (state.owed && focusFirst(element, { wait: true })) state.owed = false;
		});
		element.addEventListener('focusin', onFocus);
		element.addEventListener('focusout', onBlur);
		observer.observe(element, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['disabled'],
		});
		return () => {
			element.removeEventListener('focusin', onFocus);
			element.removeEventListener('focusout', onBlur);
			observer.disconnect();
		};
	}, [dialog]);
};

/** The dialog on top: the last modal one on the page. Only it answers keys. */
const onTop = (element: HTMLElement): boolean => {
	const open = document.querySelectorAll('[aria-modal="true"]');
	return open[open.length - 1] === element;
};

export interface DialogProps {
	title: string;
	/** What it asks, or is about, under the title: read after it. */
	text?: ReactNode;
	/** What describes it, where that is not `text`: an id within `children`. */
	describedBy?: string | undefined;
	children?: ReactNode;
	/**
	 * Escape, and the button that starts the row. Without it, neither: the
	 * dialog is answered, or goes when what it waits on is done.
	 */
	onClose?: (() => void) | undefined;
	/** The way out's words: Cancel while something is asked, Close once nothing is. */
	closeLabel?: string | undefined;
	/** `alertdialog` where it asks something that has to be answered. */
	role?: 'dialog' | 'alertdialog';
	/** A form: Enter in a field is the answer. */
	onSubmit?: (() => void) | undefined;
	/** What is under way, said over the row. */
	status?: string | undefined;
	/** Something is under way that the way out would not stop: it waits, and Escape with it. */
	busy?: boolean | undefined;
	/**
	 * Where the focus goes when the dialog does. Without it, back to whatever
	 * had it before, if that is still on the page.
	 */
	returnFocus?: RefObject<HTMLElement | null> | undefined;
	className?: string | undefined;
}

export const Dialog = ({
	title,
	text,
	describedBy,
	children,
	onClose,
	closeLabel = t('common.cancel'),
	role = 'dialog',
	onSubmit,
	status,
	busy,
	returnFocus,
	className,
}: DialogProps) => {
	const titleId = useId();
	const textId = useId();
	const dialog = useRef<HTMLElement | null>(null);
	const setDialog = useCallback((element: HTMLElement | null) => {
		dialog.current = element;
	}, []);
	// What had the focus as the dialog was asked for: read as it is first
	// drawn, before a field inside it takes the focus in an effect of its own.
	const [opener] = useState(() => document.activeElement);
	useSuspendShortcuts();
	useRefocus(dialog);

	useEffect(() => {
		// Read now: what it names is on the page for as long as the dialog is.
		const back = returnFocus?.current ?? opener;
		const element = dialog.current;
		if (element !== null && !element.contains(document.activeElement)) focusFirst(element);
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is taken once and given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// On the document, not the dialog: a step that goes takes the focus with
	// it, to the page's body, for a moment, and the keys must still reach the
	// dialog then.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const element = dialog.current;
			if (event.defaultPrevented || element === null || !onTop(element)) return;
			if (event.key === 'Escape') {
				if (onClose === undefined) return;
				event.preventDefault();
				if (busy !== true) onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const reachable = [...element.querySelectorAll<HTMLElement>(REACHABLE)];
			const at = reachable.indexOf(document.activeElement as HTMLElement);
			const from = at === -1 && event.shiftKey ? 0 : at;
			const next = (from + (event.shiftKey ? -1 : 1) + reachable.length) % reachable.length;
			event.preventDefault();
			reachable[next]?.focus();
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
		};
	}, [onClose, busy]);

	const shell = {
		ref: setDialog,
		className: className === undefined ? 'modal' : `modal ${className}`,
		'data-dialog': '',
		role,
		'aria-modal': true,
		'aria-labelledby': titleId,
		'aria-describedby': text === undefined ? describedBy : textId,
	} as const;
	const inside = (
		<>
			<h2 id={titleId}>{title}</h2>
			{text !== undefined && <p id={textId}>{text}</p>}
			<ClosingContext.Provider
				value={
					onClose === undefined ? undefined : { label: closeLabel, onClose, status, busy }
				}
			>
				{children}
			</ClosingContext.Provider>
		</>
	);

	return createPortal(
		<div className="modal-backdrop">
			{onSubmit === undefined ? (
				<div {...shell}>{inside}</div>
			) : (
				<form
					{...shell}
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					{inside}
				</form>
			)}
		</div>,
		document.body
	);
};

export interface InlineDialogProps {
	/** What it asks, as a screen reader names the group. */
	label: string;
	/** What describes it: an id within `children`. */
	describedBy?: string | undefined;
	children: ReactNode;
	/** Escape, and the button that starts the row. */
	onClose: () => void;
	closeLabel?: string | undefined;
	/** What is under way, said over the row. */
	status?: string | undefined;
	/** Something is under way that the way out would not stop: it waits, and Escape with it. */
	busy?: boolean | undefined;
	className?: string | undefined;
}

/**
 * A question asked in place, in a panel: not modal, so neither Tab nor the
 * shortcuts are held, but its buttons, its focus and its Escape are as a
 * dialog's are. A listener rather than an `onKeyDown` on the group: the group
 * is not itself interactive, and a key handler on it would say otherwise to
 * assistive technology. The buttons inside it are, and the key bubbles up.
 */
export const InlineDialog = ({
	label,
	describedBy,
	children,
	onClose,
	closeLabel = t('common.cancel'),
	status,
	busy,
	className,
}: InlineDialogProps) => {
	const group = useRef<HTMLElement | null>(null);
	const setGroup = useCallback((element: HTMLElement | null) => {
		group.current = element;
	}, []);
	useRefocus(group);

	useEffect(() => {
		const element = group.current;
		// Only focus still about this place to move: a question that took
		// seconds to come — a push to finish first — does not pull a user out
		// of the note they went back to meanwhile.
		const active = document.activeElement;
		const free =
			active === null ||
			active === document.body ||
			element?.parentElement?.contains(active) === true;
		if (element !== null && free) focusFirst(element);
	}, []);

	useEffect(() => {
		const element = group.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			if (busy !== true) onClose();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [onClose, busy]);

	return (
		<div
			ref={setGroup}
			className={className}
			data-dialog=""
			role="group"
			aria-label={label}
			aria-describedby={describedBy}
		>
			<ClosingContext.Provider value={{ label: closeLabel, onClose, status, busy }}>
				{children}
			</ClosingContext.Provider>
		</div>
	);
};

export interface DialogActionsProps {
	/** The answer: last in the row, and where the focus starts if no field takes it. */
	primary?: ReactNode;
	/** Whatever else can be done, between the way out and the answer. */
	children?: ReactNode;
	/**
	 * Whether the dialog's way out starts the row. A step whose own Cancel goes
	 * back rather than out leaves it off, and puts that Cancel first itself.
	 */
	close?: boolean;
}

/** A dialog's buttons: one row, at its end, the way out first and the answer last. */
export const DialogActions = ({ primary, children, close = true }: DialogActionsProps) => {
	const closing = useContext(ClosingContext);
	return (
		<>
			{closing?.status !== undefined && (
				<p className="dialog-status" role="status">
					{closing.status}
				</p>
			)}
			<div className="dialog-actions">
				{close && closing !== undefined && (
					<button
						type="button"
						data-dialog-close=""
						disabled={closing.busy === true}
						onClick={closing.onClose}
					>
						{closing.label}
					</button>
				)}
				{children}
				{primary !== undefined && (
					<span className="dialog-primary" data-dialog-primary="">
						{primary}
					</span>
				)}
			</div>
		</>
	);
};
