import { cell } from '@skysa/core';
import {
	Children,
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
import { Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import { rems } from './layout.js';

/**
 * Every dialog the app draws, built one way (docs/ARCHITECTURE.md §7,
 * "Dialogs"; the owner's rules, 2026-10-15):
 *
 * - The buttons are one row at the dialog's end (`DialogActions`): the answer
 *   on the right, and everything else on the left, Cancel first where
 *   something is asked.
 * - A dialog with a way out has a ✕ in its corner, and a press on the page
 *   around it is the way out too. Once nothing is asked, the ✕ is the only
 *   one: there is no Close in the row.
 * - However much it holds, it fits in the window, and above a phone's
 *   keyboard: its title and its row stay where they are, and what is between
 *   them scrolls, the field being typed in kept in sight.
 * - The focus starts on the first field, where something is typed or drawn,
 *   and otherwise on the answer. A step drawn in place of another takes it the
 *   same way.
 * - Escape is the way out, where there is one. A dialog that has to be
 *   answered has neither, nor a ✕.
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
	readonly onClose?: (() => void) | undefined;
	/** Whether the row starts with the way out: not where the ✕ is the only one. */
	readonly inRow: boolean;
	/** What is under way, said over the row. */
	readonly status?: string | undefined;
	/** Something is under way that the way out would not stop: it waits. */
	readonly busy?: boolean | undefined;
}

const ClosingContext = createContext<Closing | undefined>(undefined);

/**
 * Where the row is: at the foot of a dialog over everything, where it stays in
 * sight as what is above it scrolls, or in a question asked in place.
 */
const FrameContext = createContext<'modal' | 'inline' | undefined>(undefined);

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
 * What the focus was put on for want of a field or an answer — the ✕, while
 * the dialog is still finding out what to show — and has stayed on: it goes on
 * to the field or the answer a step then draws, as it would have from a way
 * out that went with the step it was in.
 */
const parked = new WeakSet<Element>();

/** Where `focusFirst` puts the focus, if anywhere. */
const firstOf = (element: HTMLElement, wait: boolean): HTMLElement | null => {
	const waiting = wait && own(element, PRIMARY) !== null;
	return (
		own(element, FIELD) ??
		own(element, `${PRIMARY}:not(:disabled)`) ??
		(waiting
			? null
			: (own(element, '[data-dialog-close]') ??
				element.querySelector<HTMLElement>(REACHABLE)))
	);
};

/**
 * Where the focus goes in a dialog as it opens, or as a step of it is drawn:
 * the first field; else the answer; else the way out; else whatever can take
 * it. With `wait`, an answer there but not to be given yet — a try under way —
 * is waited for, rather than the focus going on to the way out, where Enter
 * would leave. Whether it went anywhere.
 */
const focusFirst = (element: HTMLElement, { wait = false } = {}): boolean => {
	const target = firstOf(element, wait);
	target?.focus();
	if (target !== null && !target.matches(`${FIELD}, ${PRIMARY}`)) parked.add(target);
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
			if (event.target instanceof Element) parked.delete(event.target);
			const to = event.relatedTarget;
			if (to instanceof Node && !element.contains(to)) state.focused = null;
		};
		const observer = new MutationObserver(() => {
			const active = document.activeElement;
			if (active !== null && parked.has(active) && element.contains(active)) {
				const next = firstOf(element, true);
				if (next !== null && next !== active) focusFirst(element, { wait: true });
				return;
			}
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

/** The visual viewport, if there is one. jsdom has none at all: `undefined`, where the types say `null`. */
const viewportOf = (): VisualViewport | null => window.visualViewport ?? null;

/** Room kept between the field being typed in and the edges of what can be seen of it, in rems. */
const ROOM = 0.75;

/**
 * Scroll the dialog's middle so `field` is in sight in it: not under its row,
 * which stays at the foot over what scrolls, nor above its top. Upwards as
 * readily as down, and never so far that a field taller than the room loses
 * its own top.
 */
export const revealField = (body: HTMLElement, field: HTMLElement): void => {
	const room = rems(ROOM);
	const box = body.getBoundingClientRect();
	// Not laid out: nothing to scroll.
	if (box.height <= 0) return;
	const foot = body.querySelector<HTMLElement>('.dialog-foot');
	const top = box.top + room;
	const bottom = box.bottom - (foot?.offsetHeight ?? 0) - room;
	const at = field.getBoundingClientRect();
	const below = at.bottom - bottom;
	const above = top - at.top;
	if (below > 0) {
		body.scrollBy({ top: Math.min(below, -above), behavior: 'instant' });
		return;
	}
	if (above > 0) body.scrollBy({ top: -above, behavior: 'instant' });
};

/**
 * The backdrop held to what can be seen of the page: on a phone whose
 * keyboard covers the bottom of the window rather than making it shorter, as
 * an iPhone's does, the dialog then sits over what is left, not partly under
 * the keys. Where the window does get shorter, as on Android
 * (`interactive-widget=resizes-content` in index.html), the two are the same.
 *
 * And when what can be seen changes — a keyboard coming up — the field being
 * typed in is brought back into sight in the dialog's middle, which has just
 * got shorter around it.
 */
const useFitViewport = (
	backdrop: RefObject<HTMLElement | null>,
	body: RefObject<HTMLElement | null>
): void => {
	useEffect(() => {
		const view = viewportOf();
		const frame = cell(0);
		const fit = () => {
			if (view === null) return;
			backdrop.current?.style.setProperty('--viewport-top', `${String(view.offsetTop)}px`);
			backdrop.current?.style.setProperty('--viewport-height', `${String(view.height)}px`);
		};
		const reveal = () => {
			const middle = body.current;
			const active = document.activeElement;
			if (middle === null || !(active instanceof HTMLElement)) return;
			if (middle.contains(active) && active.matches(FIELD)) revealField(middle, active);
		};
		// A frame later, for the layout the new size makes; once for a run of
		// resizes, which a keyboard sliding up fires several of.
		const resized = () => {
			fit();
			window.cancelAnimationFrame(frame.current);
			frame.current = window.requestAnimationFrame(reveal);
		};
		fit();
		const target = view ?? window;
		target.addEventListener('resize', resized);
		view?.addEventListener('scroll', fit);
		return () => {
			target.removeEventListener('resize', resized);
			view?.removeEventListener('scroll', fit);
			window.cancelAnimationFrame(frame.current);
		};
	}, [backdrop, body]);
};

/**
 * What the dialog's middle has out of sight, said on the dialog for the rules
 * that draw a line under its title (`data-scrolled`) and over its row
 * (`data-more`) only then; and how tall the row is, so a field the focus moves
 * to is scrolled clear of it (`--dialog-foot`, its `scroll-padding`).
 */
const useOverflow = (
	dialog: RefObject<HTMLElement | null>,
	body: RefObject<HTMLElement | null>
): void => {
	useEffect(() => {
		const element = dialog.current;
		const middle = body.current;
		if (element === null || middle === null) return undefined;
		const measure = () => {
			const foot = middle.querySelector<HTMLElement>('.dialog-foot');
			const end = middle.scrollTop + middle.clientHeight;
			element.toggleAttribute('data-scrolled', middle.scrollTop > 0);
			element.toggleAttribute('data-more', end < middle.scrollHeight - 1);
			middle.style.setProperty('--dialog-foot', `${String(foot?.offsetHeight ?? 0)}px`);
		};
		measure();
		const resizing =
			typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
		resizing?.observe(middle);
		// What is in it changing, a step drawn in place of another.
		const changing = new MutationObserver(measure);
		changing.observe(middle, { childList: true, subtree: true });
		middle.addEventListener('scroll', measure, { passive: true });
		return () => {
			resizing?.disconnect();
			changing.disconnect();
			middle.removeEventListener('scroll', measure);
		};
	}, [dialog, body]);
};

/**
 * A press on the page around the dialog, begun there and let go there, is its
 * way out: not one begun in the dialog — a drag across a field's text, or a
 * pattern's — that ends outside it.
 */
const usePressOutside = (
	backdrop: RefObject<HTMLElement | null>,
	onClose: (() => void) | undefined,
	busy: boolean | undefined
): void => {
	useEffect(() => {
		const element = backdrop.current;
		if (element === null || onClose === undefined) return undefined;
		const began = cell(false);
		const onDown = (event: PointerEvent) => {
			began.current = event.target === element;
		};
		const onClick = (event: MouseEvent) => {
			const outside = began.current && event.target === element;
			began.current = false;
			if (outside && busy !== true) onClose();
		};
		element.addEventListener('pointerdown', onDown);
		element.addEventListener('click', onClick);
		return () => {
			element.removeEventListener('pointerdown', onDown);
			element.removeEventListener('click', onClick);
		};
	}, [backdrop, onClose, busy]);
};

export interface DialogProps {
	title: string;
	/** What it asks, or is about, under the title: read after it. */
	text?: ReactNode;
	/** What describes it, where that is not `text`: an id within `children`. */
	describedBy?: string | undefined;
	children?: ReactNode;
	/**
	 * The ✕, Escape, a press outside, and the row's Cancel. Without it, none of
	 * them: the dialog is answered, or goes when what it waits on is done.
	 */
	onClose?: (() => void) | undefined;
	/**
	 * Whether the row starts with Cancel, as it does while something is asked.
	 * Once nothing is, the ✕ is the way out, and the row has none of its own.
	 */
	cancel?: boolean | undefined;
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
	/**
	 * Mounted, so what it holds can begin, but not drawn yet, and taking
	 * neither the focus nor a key: the unlock dialog while the device's own
	 * lock is asked, drawn only where that does not unlock (`UnlockDialog`).
	 */
	hidden?: boolean | undefined;
	className?: string | undefined;
}

export const Dialog = ({
	title,
	text,
	describedBy,
	children,
	onClose,
	cancel = true,
	role = 'dialog',
	onSubmit,
	status,
	busy,
	returnFocus,
	hidden = false,
	className,
}: DialogProps) => {
	const titleId = useId();
	const textId = useId();
	const dialog = useRef<HTMLElement | null>(null);
	const setDialog = useCallback((element: HTMLElement | null) => {
		dialog.current = element;
	}, []);
	const backdrop = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	// What had the focus as the dialog was asked for: read as it is first
	// drawn, before a field inside it takes the focus in an effect of its own.
	const [opener] = useState(() => document.activeElement);
	useSuspendShortcuts();
	useRefocus(dialog);
	useFitViewport(backdrop, body);
	useOverflow(dialog, body);
	usePressOutside(backdrop, onClose, busy);

	useEffect(() => {
		// Read now: what it names is on the page for as long as the dialog is.
		const back = returnFocus?.current ?? opener;
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Taken as the dialog is first drawn: as it opens, or as it stops being hidden.
	useEffect(() => {
		const element = dialog.current;
		if (hidden || element === null || element.contains(document.activeElement)) return;
		focusFirst(element);
	}, [hidden]);

	// On the document, not the dialog: a step that goes takes the focus with
	// it, to the page's body, for a moment, and the keys must still reach the
	// dialog then.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const element = dialog.current;
			if (hidden || event.defaultPrevented || element === null || !onTop(element)) return;
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
	}, [onClose, busy, hidden]);

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
			<div className="modal-head">
				<h2 id={titleId}>{title}</h2>
				{onClose !== undefined && (
					<button
						type="button"
						className="icon icon-quiet modal-close"
						data-dialog-close=""
						aria-label={t('common.close')}
						title={t('common.close')}
						disabled={busy === true}
						onClick={onClose}
					>
						<Icon name="close" />
					</button>
				)}
			</div>
			<div ref={body} className="modal-body">
				{text !== undefined && <p id={textId}>{text}</p>}
				<FrameContext.Provider value="modal">
					<ClosingContext.Provider
						value={{
							label: t('common.cancel'),
							onClose,
							inRow: cancel,
							status,
							busy,
						}}
					>
						{children}
					</ClosingContext.Provider>
				</FrameContext.Provider>
			</div>
		</>
	);

	return createPortal(
		<div ref={backdrop} className="modal-backdrop" hidden={hidden}>
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
			<FrameContext.Provider value="inline">
				<ClosingContext.Provider
					value={{ label: closeLabel, onClose, inRow: true, status, busy }}
				>
					{children}
				</ClosingContext.Provider>
			</FrameContext.Provider>
		</div>
	);
};

/**
 * Where a step goes on to another way of doing what it does, or to something
 * else that can be done from it: a list in the dialog's middle, a row each with
 * a chevron saying it goes on, so the row at the foot keeps to its answer.
 */
export const DialogOptions = ({ children }: { children: ReactNode }) => (
	<div className="dialog-options">{children}</div>
);

export const DialogOption = ({
	onClick,
	children,
}: {
	onClick: () => void;
	children: ReactNode;
}) => (
	<button type="button" className="dialog-option" onClick={onClick}>
		<span>{children}</span>
		<Icon name="chevron" className="dialog-option-icon" />
	</button>
);

export interface DialogActionsProps {
	/** The answer: on the right, and where the focus starts if no field takes it. */
	primary?: ReactNode;
	/** Whatever else can be done: on the left, after the way out. */
	children?: ReactNode;
	/**
	 * Whether the dialog's way out starts the row. A step whose own Cancel goes
	 * back rather than out leaves it off, and puts that Cancel first itself.
	 */
	close?: boolean;
}

/**
 * A dialog's buttons: one row, at its end — the way out and whatever else can
 * be done on the left, the answer on the right. At the foot of a dialog over
 * everything, the row stays in sight while what is above it scrolls. Where
 * there is nothing to put in it, there is no row.
 */
export const DialogActions = ({ primary, children, close = true }: DialogActionsProps) => {
	const closing = useContext(ClosingContext);
	const frame = useContext(FrameContext);
	const onClose = closing?.onClose;
	const way =
		close && closing?.inRow === true && onClose !== undefined ? (
			<button
				type="button"
				data-dialog-close=""
				disabled={closing.busy === true}
				onClick={onClose}
			>
				{closing.label}
			</button>
		) : null;
	const others = Children.toArray(children);
	const any = way !== null || others.length > 0 || primary !== undefined;
	const status = closing?.status;
	if (!any && status === undefined) return null;
	const row = (
		<>
			{status !== undefined && (
				<p className="dialog-status" role="status">
					{status}
				</p>
			)}
			{any && (
				<div className="dialog-actions">
					{way}
					{others}
					{primary !== undefined && (
						<span className="dialog-primary" data-dialog-primary="">
							{primary}
						</span>
					)}
				</div>
			)}
		</>
	);
	return frame === 'modal' ? <div className="dialog-foot">{row}</div> : row;
};
