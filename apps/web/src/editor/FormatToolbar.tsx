import type { Ctx } from '@milkdown/kit/ctx';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { flushSync } from 'react-dom';

import {
	clearLink,
	type EditorCommand,
	INDENT_COMMANDS,
	INSERT_COMMANDS,
	LIST_COMMANDS,
	MORE_INLINE_COMMANDS,
	PRIMARY_INLINE_COMMANDS,
	setLink,
	TEXT_STYLES,
} from './commands.js';
import type { FormatState } from './format.js';
import { Icon, type IconName } from './icons.js';
import { fitToolbar, sameFit } from './toolbarFit.js';

/**
 * The formatting toolbar across the top of the rich editor.
 *
 * Grouped the way Atlassian's editor groups it — text style, then the inline
 * marks, then lists, then indentation, then the link — because that order is
 * what most people writing in a browser already have in their hands. What is
 * missing from it is missing for one reason: markdown cannot hold it. There is
 * no text colour, no highlight and no alignment in a `.md` file, and a button
 * that wrote one would put something in the user's note that the file format
 * loses on the next save. Insert — tables, quotes, dividers — is the slash
 * menu's job here and is deliberately not duplicated; the code block is the one
 * exception, and `INSERT_COMMANDS` says why it earns a button of its own.
 *
 * Every button is a view of `FormatState` and an action on the editor, and
 * nothing else: the component holds no document state, so it cannot disagree
 * with the text.
 */

export interface FormatToolbarProps {
	/** What the selection is, as `format.ts` reads it. */
	format: FormatState;
	/** Run a command against the open editor. */
	run: (apply: (ctx: Ctx) => void) => void;
}

const ICONS: Record<string, IconName> = {
	strong: 'bold',
	emphasis: 'italic',
	strike: 'strike',
	code: 'code',
	'code-block': 'code-block',
	'clear-formatting': 'clear',
	'bullet-list': 'bullets',
	'ordered-list': 'numbers',
	'task-list': 'tasks',
	outdent: 'outdent',
	indent: 'indent',
};

/** The mark a toggle button reports on, where it reports on one. */
const MARKS: Record<string, string> = {
	strong: 'strong',
	emphasis: 'emphasis',
	strike: 'strike_through',
	code: 'inlineCode',
};

/** The block a toggle button reports on, where it reports on one. */
const BLOCKS: Record<string, keyof FormatState> = {
	'code-block': 'codeBlock',
};

const LISTS: Record<string, FormatState['list']> = {
	'bullet-list': 'bullet',
	'ordered-list': 'ordered',
	'task-list': 'task',
};

/** Whether the button should be drawn as already applied. */
const isOn = (command: EditorCommand, format: FormatState): boolean => {
	const mark = MARKS[command.id];
	if (mark !== undefined) return format.marks.includes(mark);
	const list = LISTS[command.id];
	if (list !== undefined) return format.list === list;
	const block = BLOCKS[command.id];
	if (block !== undefined) return format[block] === true;
	return false;
};

/**
 * Indentation is list nesting, so the two buttons are grey wherever nesting is
 * not what would happen — which includes the first item of a list, where
 * `sinkListItem` refuses.
 */
const isOff = (command: EditorCommand, format: FormatState): boolean => {
	if (command.id === 'indent') return !format.canIndent;
	if (command.id === 'outdent') return !format.canOutdent;
	// A code block holds no marks — the schema says so — so the buttons that
	// would add one are grey there rather than lit and inert.
	if (MARKS[command.id] !== undefined) return format.codeBlock;
	return false;
};

/** The first control in the bar, and so the one that carries the tab stop. */
const FIRST_STOP = 'text-style';

/**
 * The bar's slots, in the order they are drawn, and the group each is drawn
 * in. A slot is what goes into the overflow menu as one: a button, a menu, or
 * — for indentation — the pair, since either without the other is half a
 * control.
 */
const SLOTS: readonly { id: string; group: string }[] = [
	{ id: 'text-style', group: 'Text style' },
	{ id: 'strong', group: 'Text formatting' },
	{ id: 'emphasis', group: 'Text formatting' },
	{ id: 'more-formatting', group: 'Text formatting' },
	{ id: 'bullet-list', group: 'Lists' },
	{ id: 'ordered-list', group: 'Lists' },
	{ id: 'task-list', group: 'Lists' },
	{ id: 'indentation', group: 'Indentation' },
	{ id: 'code-block', group: 'Insert' },
	{ id: 'link', group: 'Link' },
];

/** The slot a tab stop is in, where it is not a slot of its own. */
const SLOT_OF_STOP: Record<string, string> = { outdent: 'indentation', indent: 'indentation' };

/**
 * What goes into the overflow menu first, when the bar is too narrow for all
 * of it: least used first. Indentation is mostly done with Tab and a code
 * block with three backticks; strikethrough, inline code and clearing are
 * already a menu of their own. Bold and italic go last of all, and the text
 * style never does — it is the widest control, but it is also the one that
 * says what the cursor is in.
 */
const GIVE_UP_ORDER: readonly string[] = [
	'code-block',
	'indentation',
	'more-formatting',
	'task-list',
	'link',
	'ordered-list',
	'bullet-list',
	'emphasis',
	'strong',
];

const COMMANDS_BY_ID = new Map(
	[...PRIMARY_INLINE_COMMANDS, ...LIST_COMMANDS, ...INSERT_COMMANDS].map((command) => [
		command.id,
		command,
	])
);

/**
 * Which slots fit, measured.
 *
 * Every slot's width is taken from the screen while it is on it and kept once
 * it has gone, so the bar can tell when one would fit again without drawing it
 * to find out. Measured after every render as well as on a resize, because a
 * render can change a width: the text style reads "Plain text" in one
 * paragraph and "Heading 1" in the next.
 *
 * A bar with no width — jsdom, where nothing is laid out, or a toolbar not on
 * screen — is left alone, with everything in it.
 */
/** What the bar has measured, kept between renders. */
interface FitMemory {
	widths: Map<string, number>;
	groupCost: Map<string, number>;
	overflowWidth: number | undefined;
}

const pixels = (value: string): number => Number.parseFloat(value) || 0;

/** Measure what is on the bar, and work out what fits. */
const measureFit = (
	bar: HTMLElement | null,
	memory: FitMemory
): ReadonlySet<string> | undefined => {
	if (bar === null || bar.clientWidth === 0) return undefined;
	const style = getComputedStyle(bar);

	bar.querySelectorAll<HTMLElement>('[data-slot]').forEach((slot) => {
		memory.widths.set(slot.dataset.slot ?? '', slot.offsetWidth);
	});
	bar.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
		const inside = [...group.querySelectorAll<HTMLElement>('[data-slot]')].reduce(
			(sum, slot) => sum + slot.offsetWidth,
			0
		);
		memory.groupCost.set(group.dataset.group ?? '', group.offsetWidth - inside);
	});
	const overflow = bar.querySelector<HTMLElement>('[data-overflow]');
	if (overflow !== null) memory.overflowWidth = overflow.offsetWidth;

	return fitToolbar({
		slots: SLOTS.map((slot) => ({ ...slot, width: memory.widths.get(slot.id) ?? 0 })),
		groupCost: memory.groupCost,
		gap: pixels(style.columnGap),
		available:
			bar.clientWidth - pixels(style.paddingInlineStart) - pixels(style.paddingInlineEnd),
		// Until it has been drawn, as wide as the bold button, which is drawn
		// in the same style.
		overflowWidth: memory.overflowWidth ?? memory.widths.get('strong') ?? 0,
		order: GIVE_UP_ORDER,
	});
};

/**
 * Which slots fit, measured.
 *
 * Every slot's width is taken from the screen while it is on it and kept once
 * it has gone, so the bar can tell when one would fit again without drawing it
 * to find out. Measured after every render as well as on a resize, because a
 * render can change a width: the text style reads "Plain text" in one
 * paragraph and "Heading 1" in the next.
 *
 * A bar with no width — jsdom, where nothing is laid out, or a toolbar not on
 * screen — is left alone, with everything in it.
 */
const useToolbarFit = (root: RefObject<HTMLDivElement | null>): ReadonlySet<string> => {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const memory = useRef<FitMemory>({
		widths: new Map(),
		groupCost: new Map(),
		overflowWidth: undefined,
	});

	// After every render, on purpose: see above. It settles on the second
	// pass — the answer is the same, and `sameFit` hands back the same set, so
	// React has nothing to render again.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		const next = measureFit(root.current, memory.current);
		if (next !== undefined) setHidden((current) => (sameFit(current, next) ? current : next));
	});

	useEffect(() => {
		const bar = root.current;
		if (bar === null || typeof ResizeObserver === 'undefined') return undefined;
		// Synchronously, so a window being dragged narrower never shows a
		// frame with the bar running off its end.
		const observer = new ResizeObserver(() => {
			const next = measureFit(bar, memory.current);
			if (next === undefined) return;
			flushSync(() => {
				setHidden((current) => (sameFit(current, next) ? current : next));
			});
		});
		observer.observe(bar);
		return () => {
			observer.disconnect();
		};
	}, [root]);

	return hidden;
};

/**
 * One tab stop for the whole bar, arrow keys within it.
 *
 * A toolbar of fourteen buttons between the note's title and its text would
 * otherwise be fourteen presses of Tab in the way of every keyboard user who
 * only wanted to reach the note. Which control holds the stop is read from the
 * DOM rather than from a list kept beside it, so the order on screen and the
 * order the arrows follow are the same thing.
 */
const useRoving = (root: RefObject<HTMLDivElement | null>, hidden: ReadonlySet<string>) => {
	const [chosen, setAt] = useState<string>(FIRST_STOP);
	// The control holding the stop can go into the overflow menu when the bar
	// narrows, and a bar whose one tab stop is not drawn is a bar Tab skips.
	const at = hidden.has(SLOT_OF_STOP[chosen] ?? chosen) ? FIRST_STOP : chosen;

	const move = (delta: number, from: 'here' | 'edge') => {
		const stops = [
			...(root.current?.querySelectorAll<HTMLButtonElement>('[data-stop]') ?? []),
		].filter((stop) => !stop.disabled);
		const index =
			from === 'here' ? stops.indexOf(document.activeElement as HTMLButtonElement) : -1;
		const next = stops.at((index + delta + stops.length) % stops.length);
		if (next === undefined) return;
		next.focus();
		setAt(next.dataset.stop ?? FIRST_STOP);
	};

	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (event.key === 'ArrowRight') move(1, 'here');
		if (event.key === 'ArrowLeft') move(-1, 'here');
		if (event.key === 'Home') move(1, 'edge');
		if (event.key === 'End') move(0, 'edge');
		if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) event.preventDefault();
	};

	const stop = (id: string) => ({
		'data-stop': id,
		tabIndex: at === id ? 0 : -1,
		onFocus: () => {
			setAt(id);
		},
	});

	return { onKeyDown, stop };
};

/**
 * Close when the next press lands outside, and on Escape.
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
	useEffect(() => {
		if (!open) return;

		const onPointerDown = (event: PointerEvent) => {
			if (host.current?.contains(event.target as Node) === true) return;
			close(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Claimed, so that the app's own shortcut registry — which stands
			// aside for a keystroke somebody nearer has acted on
			// (`commands/context.tsx`) — does not also read this one as closing
			// something further away.
			event.preventDefault();
			close(true);
		};

		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeyDown, true);
		};
	}, [open, close, host]);
};

const ToolbarButton = ({
	command,
	format,
	run,
	stop,
}: FormatToolbarProps & {
	command: EditorCommand;
	stop: ReturnType<ReturnType<typeof useRoving>['stop']>;
}) => {
	const icon = ICONS[command.id];
	const on = isOn(command, format);

	return (
		<button
			type="button"
			className={on ? 'toolbar-button toolbar-button-on' : 'toolbar-button'}
			title={command.label}
			aria-label={command.label}
			aria-pressed={on}
			disabled={isOff(command, format)}
			// Before the browser moves focus and drops the selection.
			onMouseDown={(event) => {
				event.preventDefault();
				run(command.apply);
			}}
			{...stop}
		>
			{icon === undefined ? command.label : <Icon name={icon} />}
		</button>
	);
};

/**
 * A button with a panel under it. Not `role="menu"`: the panels hold ordinary
 * buttons and a text field, Tab moves through them as it would anywhere else,
 * and claiming a menu would promise arrow-key semantics this does not have.
 */
const ToolbarPopover = ({
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
	stop: ReturnType<ReturnType<typeof useRoving>['stop']>;
	children: ReactNode;
}) => {
	const host = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);

	const close = useCallback(
		(restoreFocus: boolean) => {
			setOpen(false);
			if (restoreFocus) button.current?.focus();
		},
		[setOpen]
	);
	useDismiss(open, close, host);

	return (
		<div
			className={
				className === undefined
					? 'toolbar-popover-host'
					: `toolbar-popover-host ${className}`
			}
			ref={host}
			{...(id === 'overflow' ? { 'data-overflow': '' } : {})}
		>
			<button
				type="button"
				ref={button}
				className={open ? 'toolbar-button toolbar-button-on' : 'toolbar-button'}
				title={label}
				aria-label={announce ?? label}
				aria-haspopup="true"
				aria-expanded={open}
				aria-controls={open ? `${id}-panel` : undefined}
				// The editor keeps its selection while the panel is open, so the
				// command picked from it still knows what it is acting on.
				onMouseDown={(event) => {
					event.preventDefault();
					setOpen(!open);
				}}
				{...stop}
			>
				{trigger}
				{chevron && <Icon name="chevron" />}
			</button>
			{open && (
				<div className="toolbar-panel" id={`${id}-panel`} aria-label={label}>
					{children}
				</div>
			)}
		</div>
	);
};

/** Plain text, or one of the six headings. */
const TextStyleMenu = ({
	format,
	run,
	open,
	setOpen,
	stop,
}: FormatToolbarProps & {
	open: boolean;
	setOpen: (open: boolean) => void;
	stop: ReturnType<ReturnType<typeof useRoving>['stop']>;
}) => {
	const current = TEXT_STYLES.find((style) => style.level === format.level);

	return (
		<ToolbarPopover
			id="text-style"
			label="Text style"
			announce={`Text style: ${current?.command.label ?? 'Plain text'}`}
			trigger={
				<span className="toolbar-style">{current?.command.label ?? 'Plain text'}</span>
			}
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
					onMouseDown={(event) => {
						event.preventDefault();
						run(style.command.apply);
						setOpen(false);
					}}
				>
					<span className={`toolbar-sample toolbar-sample-${String(style.level)}`}>
						{style.command.label}
					</span>
					{style.level === format.level && <Icon name="check" />}
				</button>
			))}
		</ToolbarPopover>
	);
};

/** A command as a row in a menu: its icon, its name, and whether it is on. */
const MenuCommand = ({
	command,
	format,
	run,
	close,
}: FormatToolbarProps & { command: EditorCommand; close: () => void }) => {
	const icon = ICONS[command.id];
	return (
		<button
			type="button"
			className="toolbar-item"
			aria-pressed={isOn(command, format)}
			disabled={isOff(command, format)}
			onMouseDown={(event) => {
				event.preventDefault();
				run(command.apply);
				close();
			}}
		>
			{icon !== undefined && <Icon name={icon} />}
			<span>{command.label}</span>
		</button>
	);
};

/** Strikethrough, code, and taking it all off again. */
const MoreFormatting = ({
	format,
	run,
	open,
	setOpen,
	stop,
}: FormatToolbarProps & {
	open: boolean;
	setOpen: (open: boolean) => void;
	stop: ReturnType<ReturnType<typeof useRoving>['stop']>;
}) => (
	<ToolbarPopover
		id="more-formatting"
		label="More formatting"
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

/**
 * The field inside the link panel.
 *
 * Mounted with the panel and thrown away with it, so the URL it starts from is
 * whatever the cursor was in when the panel opened — no effect to keep it in
 * step with a `format.link` that changes as the user moves around underneath.
 */
const LinkForm = ({
	href: current,
	run,
	close,
}: {
	href: string | null;
	run: FormatToolbarProps['run'];
	close: () => void;
}) => {
	const [href, setHref] = useState(current ?? '');
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);

	return (
		<form
			className="toolbar-link"
			onSubmit={(event) => {
				event.preventDefault();
				const url = href.trim();
				if (url === '') return;
				run(setLink(url));
				close();
			}}
		>
			<label htmlFor="toolbar-link-url">Link to</label>
			<input
				id="toolbar-link-url"
				ref={field}
				type="url"
				inputMode="url"
				placeholder="https://"
				value={href}
				onChange={(event) => {
					setHref(event.target.value);
				}}
			/>
			<div className="toolbar-link-actions">
				<button type="submit" disabled={href.trim() === ''}>
					Apply
				</button>
				{current !== null && (
					<button
						type="button"
						onClick={() => {
							run(clearLink);
							close();
						}}
					>
						Remove
					</button>
				)}
			</div>
		</form>
	);
};

/**
 * The link button and the panel under it.
 *
 * The field is a real text field, so the editor does lose focus to it. That is
 * why the commands here act on the ProseMirror selection rather than on the
 * browser's: the selection outlives the blur, and the editor is handed focus
 * back the moment the panel closes.
 */
const LinkPanel = ({
	format,
	run,
	open,
	setOpen,
	stop,
}: FormatToolbarProps & {
	open: boolean;
	setOpen: (open: boolean) => void;
	stop: ReturnType<ReturnType<typeof useRoving>['stop']>;
}) => (
	<ToolbarPopover
		id="link"
		label="Link"
		trigger={<Icon name="link" />}
		open={open}
		setOpen={setOpen}
		stop={stop}
	>
		<LinkForm
			href={format.link}
			run={run}
			close={() => {
				setOpen(false);
			}}
		/>
	</ToolbarPopover>
);

/**
 * Where the bar sits. Above the note in a wide window; below it in a compact
 * one, where it is under the thumb and out of the way of the title — and its
 * menus open upwards, since below it there is nothing left of the screen.
 */
export type ToolbarPlacement = 'top' | 'bottom';

/** The commands a slot stands for, as rows in the overflow menu. */
const commandsIn = (slot: string): readonly EditorCommand[] => {
	if (slot === 'more-formatting') return MORE_INLINE_COMMANDS;
	if (slot === 'indentation') return INDENT_COMMANDS;
	const command = COMMANDS_BY_ID.get(slot);
	return command === undefined ? [] : [command];
};

/**
 * What did not fit on the bar, in the order it would have been drawn.
 *
 * A menu that was a slot of its own — "more formatting" — is spread out here
 * rather than nested: a menu inside a menu is two presses and a hover-target
 * for what was one press on a wider screen. The link is the one control that
 * is more than a press, so choosing it swaps the rows for the link's own form,
 * in the same panel.
 *
 * Mounted with the panel, so the form is gone again the next time it opens.
 */
const OverflowItems = ({
	hidden,
	format,
	run,
	close,
}: FormatToolbarProps & { hidden: ReadonlySet<string>; close: () => void }) => {
	const [linking, setLinking] = useState(false);
	if (linking) return <LinkForm href={format.link} run={run} close={close} />;

	return SLOTS.filter((slot) => hidden.has(slot.id)).flatMap((slot) =>
		slot.id === 'link' ? (
			<button
				key={slot.id}
				type="button"
				className="toolbar-item"
				aria-pressed={format.link !== null}
				onMouseDown={(event) => {
					event.preventDefault();
					setLinking(true);
				}}
			>
				<Icon name="link" />
				<span>Link…</span>
			</button>
		) : (
			commandsIn(slot.id).map((command) => (
				<MenuCommand
					key={command.id}
					command={command}
					format={format}
					run={run}
					close={close}
				/>
			))
		)
	);
};

/**
 * One line, always. When the bar is too narrow for everything on it, what is
 * least used goes into a menu at the end (`GIVE_UP_ORDER`) and comes back as
 * soon as there is room for it — measured against the bar's own width rather
 * than the window's, since the same window gives the editor very different
 * room depending on what is beside it.
 */
export const FormatToolbar = ({
	format,
	run,
	placement = 'top',
}: FormatToolbarProps & { placement?: ToolbarPlacement }) => {
	const root = useRef<HTMLDivElement>(null);
	const hidden = useToolbarFit(root);
	const { onKeyDown, stop } = useRoving(root, hidden);
	/** At most one panel is open, so which one is the whole of the state. */
	const [open, setOpen] = useState<string | null>(null);
	const opener = (id: string) => (wanted: boolean) => {
		setOpen(wanted ? id : null);
	};
	// A panel whose button has gone into the menu goes with it, and the menu's
	// own panel goes when there is nothing left in it.
	const drawn = open === 'overflow' ? hidden.size > 0 : open === null || !hidden.has(open);
	const openNow = drawn ? open : null;

	const button = (command: EditorCommand) => (
		<ToolbarButton
			key={command.id}
			command={command}
			format={format}
			run={run}
			stop={stop(command.id)}
		/>
	);

	const slot = (id: string): ReactNode => {
		switch (id) {
			case 'text-style':
				return (
					<TextStyleMenu
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(FIRST_STOP)}
					/>
				);
			case 'more-formatting':
				return (
					<MoreFormatting
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(id)}
					/>
				);
			case 'link':
				return (
					<LinkPanel
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(id)}
					/>
				);
			default:
				return commandsIn(id).map(button);
		}
	};

	// The slots still on the bar, grouped; a group with nothing left in it is
	// not drawn, and its separator goes with it.
	const groups = SLOTS.filter(({ id }) => !hidden.has(id)).reduce(
		(drawn, { id, group }) => drawn.set(group, [...(drawn.get(group) ?? []), id]),
		new Map<string, string[]>()
	);

	return (
		<div
			className={
				placement === 'bottom' ? 'format-toolbar format-toolbar-bottom' : 'format-toolbar'
			}
			ref={root}
			role="toolbar"
			aria-label="Formatting"
			aria-orientation="horizontal"
			onKeyDown={onKeyDown}
		>
			{[...groups].map(([group, ids]) => (
				<div
					key={group}
					className="toolbar-group"
					role="group"
					aria-label={group}
					data-group={group}
				>
					{ids.map((id) => (
						<span key={id} className="toolbar-slot" data-slot={id}>
							{slot(id)}
						</span>
					))}
				</div>
			))}

			{hidden.size > 0 && (
				<ToolbarPopover
					id="overflow"
					label="More tools"
					trigger={<Icon name="overflow" />}
					chevron={false}
					className="toolbar-overflow"
					open={openNow === 'overflow'}
					setOpen={opener('overflow')}
					stop={stop('overflow')}
				>
					<OverflowItems
						hidden={hidden}
						format={format}
						run={run}
						close={() => {
							setOpen(null);
						}}
					/>
				</ToolbarPopover>
			)}
		</div>
	);
};
