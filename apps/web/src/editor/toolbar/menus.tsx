import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from 'react';

import { Icon } from '../../components/ui/icons.js';
import { usePressAway } from '../../components/ui/usePressAway.js';
import { t } from '../../i18n/t.js';
import { type EditorCommand, MORE_INLINE_COMMANDS, TEXT_STYLES } from '../rich/commands.js';
import type { FormatState } from '../rich/format.js';
import { onPress } from '../shared/press.js';
import type { FormatToolbarProps, ToolbarPlacement } from './types.js';
import type { Stop } from './useRoving.js';

/** Whether the button is one that is on or off (`EditorCommand.reflects`). */
const toggles = (command: EditorCommand): boolean => command.reflects !== undefined;

/** Whether the button should be drawn as already applied. */
const isOn = ({ reflects }: EditorCommand, format: FormatState): boolean => {
	if (reflects === undefined) return false;
	if ('mark' in reflects) return format.marks.includes(reflects.mark);
	if ('list' in reflects) return format.list === reflects.list;
	return format[reflects.block];
};

/**
 * Indentation is list nesting, so the two buttons are grey wherever nesting is
 * not what would happen — which includes the first item of a list, where
 * `sinkListItem` refuses.
 */
const isOff = ({ needs, reflects }: EditorCommand, format: FormatState): boolean => {
	if (needs !== undefined) return !format[needs];
	// A code block holds no marks — the schema says so — so the buttons that
	// would add one are grey there rather than lit and inert.
	return reflects !== undefined && 'mark' in reflects && format.codeBlock;
};

/**
 * Close when the next press lands outside, and on Escape. (And when focus
 * leaves the panel for somewhere else on the page: `ToolbarPopover`.)
 *
 * `close` is told which of the two it was, because they owe the user different
 * things: Escape leaves focus where the user can still see it, on the button
 * the panel belongs to, while a press somewhere else is the user saying where
 * they want to be — usually in the note — and taking focus back from them
 * would undo the click they just made.
 */
const useDismiss = (
	open: boolean,
	close: (restoreFocus: boolean) => void,
	host: RefObject<HTMLElement | null>
) => {
	usePressAway(
		[host],
		() => {
			close(false);
		},
		{ enabled: open, capture: true }
	);
	useEffect(() => {
		if (!open) return;

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Claimed, so that the app's own shortcut registry — which stands
			// aside for a keystroke somebody nearer has acted on
			// (`commands/context.tsx`) — does not also read this one as closing
			// something further away.
			event.preventDefault();
			close(true);
		};

		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
		};
	}, [open, close, host]);
};

/** What a control with a panel of its own is given. */
export interface PanelProps extends FormatToolbarProps {
	open: boolean;
	setOpen: (open: boolean) => void;
	stop: Stop;
}

export const ToolbarButton = ({
	command,
	format,
	run,
	stop,
}: FormatToolbarProps & {
	command: EditorCommand;
	stop: Stop;
}) => {
	const { icon } = command;
	const on = isOn(command, format);
	const off = isOff(command, format);

	return (
		<button
			type="button"
			className={on ? 'toolbar-button toolbar-button-on' : 'toolbar-button'}
			title={command.label}
			aria-label={command.label}
			aria-pressed={toggles(command) ? on : undefined}
			// Not `disabled`, which a browser takes focus from: an indent pressed
			// from the keyboard that leaves nothing more to indent would drop
			// focus, and the bar's one tab stop with it, until the cursor moved
			// somewhere it could indent again. A toolbar keeps a control that is
			// off where it can be reached, and says it is off.
			aria-disabled={off || undefined}
			{...onPress((by) => {
				if (!off) run(command.apply, by);
			})}
			{...stop}
		>
			{icon === undefined ? command.label : <Icon name={icon} />}
		</button>
	);
};

/** Where the bar sits, for its panels to open away from the edge it is on. */
export const Placement = createContext<ToolbarPlacement>('top');

/** Between a panel and its button, as the stylesheet hangs it: 0.25rem. */
const PANEL_GAP = 4;
/** Between a panel and the edge of what can be seen. */
const PANEL_MARGIN = 8;

/**
 * An open panel in the top layer (`popover`), placed against its button and
 * no taller than the room on its side of it. The top layer is over everything
 * and clipped by nothing: the editor, the note and the shell each hide what
 * overflows them, so a panel hung upwards from the bar at the foot of a phone,
 * with the keyboard up, was cut off under the note's title and its first items
 * could not be reached. The room is measured to the edge of the visual
 * viewport — what the keyboard leaves, wherever the phone has panned it to —
 * and what does not fit in it scrolls inside the panel. Measured again as the
 * keyboard comes and goes. `manual`, so it is shut by `useDismiss` as before
 * and not by the browser's own light dismiss. Where there is no top layer
 * (jsdom, an old browser) the stylesheet's own placement stands.
 */
const usePanelPlacement = (
	open: boolean,
	end: boolean,
	host: RefObject<HTMLElement | null>
): RefObject<HTMLDivElement | null> => {
	const placement = useContext(Placement);
	const panel = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const element = panel.current;
		const anchor = host.current;
		if (!open || element === null || anchor === null) return undefined;
		if (typeof element.showPopover !== 'function') return undefined;

		const place = () => {
			const view = window.visualViewport;
			const top = view?.offsetTop ?? 0;
			const left = view?.offsetLeft ?? 0;
			const bottom = top + (view?.height ?? window.innerHeight);
			const right = left + (view?.width ?? window.innerWidth);
			const at = anchor.getBoundingClientRect();
			const up = placement === 'bottom';
			const room = up
				? at.top - PANEL_GAP - (top + PANEL_MARGIN)
				: bottom - PANEL_MARGIN - (at.bottom + PANEL_GAP);
			element.style.maxHeight = `${String(Math.max(room, 0))}px`;
			const { offsetWidth: width, offsetHeight: height } = element;
			// Hung from the button's own edge, as the stylesheet hangs it, and
			// kept inside what can be seen.
			const from = end ? at.right - width : at.left;
			const x = Math.max(left + PANEL_MARGIN, Math.min(from, right - PANEL_MARGIN - width));
			element.style.left = `${String(x)}px`;
			element.style.top = `${String(up ? at.top - PANEL_GAP - height : at.bottom + PANEL_GAP)}px`;
		};

		// Made a popover here rather than in the markup, where a browser
		// without a top layer would still hide it as one that is not showing.
		element.setAttribute('popover', 'manual');
		element.showPopover();
		place();
		const view = window.visualViewport;
		window.addEventListener('resize', place);
		view?.addEventListener('resize', place);
		view?.addEventListener('scroll', place);
		return () => {
			window.removeEventListener('resize', place);
			view?.removeEventListener('resize', place);
			view?.removeEventListener('scroll', place);
			if (element.isConnected && element.matches(':popover-open')) element.hidePopover();
			element.removeAttribute('popover');
		};
	}, [open, end, host, placement]);

	return panel;
};

/**
 * A button with a panel under it. Not `role="menu"`: the panels hold ordinary
 * buttons and a text field, Tab moves through them as it would anywhere else,
 * and claiming a menu would promise arrow-key semantics this does not have.
 */
export const ToolbarPopover = ({
	id,
	label,
	announce,
	trigger,
	open,
	setOpen,
	stop,
	children,
	chevron = true,
	className,
}: {
	id: string;
	label: string;
	/** What a screen reader hears, where the visible text says more than `label`. */
	announce?: string;
	/** Whether the trigger carries the chevron that says it opens something. */
	chevron?: boolean;
	className?: string;
	trigger: ReactNode;
	open: boolean;
	setOpen: (open: boolean) => void;
	stop: Stop;
	children: ReactNode;
}) => {
	const host = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	// The menu at the end of the bar opens back over it, from its right edge.
	const panel = usePanelPlacement(open, id === 'overflow', host);

	const close = useCallback(
		(restoreFocus: boolean) => {
			setOpen(false);
			if (restoreFocus) button.current?.focus();
		},
		[setOpen]
	);
	useDismiss(open, close, host);

	// A panel that closes with focus in it — a row pressed from the keyboard,
	// which goes with the panel — hands focus to its button, where it was before
	// the panel opened, rather than to nowhere.
	const wasOpen = useRef(open);
	useLayoutEffect(() => {
		const owner = button.current?.ownerDocument;
		const lost = owner?.activeElement === null || owner?.activeElement === owner?.body;
		if (wasOpen.current && !open && lost) button.current?.focus();
		wasOpen.current = open;
	}, [open]);

	return (
		<div
			className={
				className === undefined
					? 'toolbar-popover-host'
					: `toolbar-popover-host ${className}`
			}
			ref={host}
			{...(id === 'overflow' ? { 'data-overflow': '' } : {})}
			// Focus gone from the panel to something else on the page — Tab past
			// its last control — and it closes, as for a press elsewhere. Not on
			// focus going nowhere, which is another window taking it, nor on focus
			// coming back to the editor from there with a panel open beside it.
			onBlur={(event) => {
				const to = event.relatedTarget;
				if (open && to instanceof Node && host.current?.contains(to) === false)
					close(false);
			}}
		>
			<button
				type="button"
				ref={button}
				className={open ? 'toolbar-button toolbar-button-on' : 'toolbar-button'}
				title={label}
				aria-label={announce ?? label}
				aria-expanded={open}
				aria-controls={open ? `${id}-panel` : undefined}
				// The editor keeps its selection while the panel is open, so the
				// command picked from it still knows what it is acting on.
				{...onPress(() => {
					setOpen(!open);
				})}
				{...stop}
			>
				{trigger}
				{chevron && <Icon name="chevron" />}
			</button>
			{open && (
				<div
					className="toolbar-panel"
					ref={panel}
					id={`${id}-panel`}
					role="group"
					aria-label={label}
				>
					{children}
				</div>
			)}
		</div>
	);
};

/** Plain text, or one of the six headings. */
export const TextStyleMenu = ({ format, run, open, setOpen, stop }: PanelProps) => {
	const current = TEXT_STYLES.find((style) => style.level === format.level);
	const shown = current?.command.label ?? t('editor.commands.plainText');

	return (
		<ToolbarPopover
			id="text-style"
			label={t('editor.toolbar.textStyle')}
			announce={t('editor.toolbar.textStyleNow', { style: shown })}
			trigger={<span className="toolbar-style">{shown}</span>}
			open={open}
			setOpen={setOpen}
			stop={stop}
		>
			{TEXT_STYLES.map((style) => (
				<button
					type="button"
					key={style.command.id}
					className="toolbar-item"
					aria-pressed={style.level === format.level}
					{...onPress((by) => {
						run(style.command.apply, by);
						setOpen(false);
					})}
				>
					<span data-sample-level={style.level}>{style.command.label}</span>
					{style.level === format.level && <Icon name="check" />}
				</button>
			))}
		</ToolbarPopover>
	);
};

/** A command as a row in a menu: its icon, its name, and whether it is on. */
export const MenuCommand = ({
	command,
	format,
	run,
	close,
}: FormatToolbarProps & { command: EditorCommand; close: () => void }) => {
	const { icon } = command;
	return (
		<button
			type="button"
			className="toolbar-item"
			aria-pressed={toggles(command) ? isOn(command, format) : undefined}
			disabled={isOff(command, format)}
			{...onPress((by) => {
				run(command.apply, by);
				close();
			})}
		>
			{icon !== undefined && <Icon name={icon} />}
			<span>{command.label}</span>
		</button>
	);
};

/** Strikethrough, code, and taking it all off again. */
export const MoreFormatting = ({ format, run, open, setOpen, stop }: PanelProps) => (
	<ToolbarPopover
		id="more-formatting"
		label={t('editor.toolbar.moreFormatting')}
		trigger={<Icon name="more" />}
		open={open}
		setOpen={setOpen}
		stop={stop}
	>
		{MORE_INLINE_COMMANDS.map((command) => (
			<MenuCommand
				key={command.id}
				command={command}
				format={format}
				run={run}
				close={() => {
					setOpen(false);
				}}
			/>
		))}
	</ToolbarPopover>
);
