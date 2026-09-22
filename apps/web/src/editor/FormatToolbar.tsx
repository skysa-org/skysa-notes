import type { Ctx } from '@milkdown/kit/ctx';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';

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
 * One tab stop for the whole bar, arrow keys within it.
 *
 * A toolbar of fourteen buttons between the note's title and its text would
 * otherwise be fourteen presses of Tab in the way of every keyboard user who
 * only wanted to reach the note. Which control holds the stop is read from the
 * DOM rather than from a list kept beside it, so the order on screen and the
 * order the arrows follow are the same thing.
 */
const useRoving = (root: RefObject<HTMLDivElement | null>) => {
	const [at, setAt] = useState<string>(FIRST_STOP);

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
}: {
	id: string;
	label: string;
	/** What a screen reader hears, where the visible text says more than `label`. */
	announce?: string;
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
		<div className="toolbar-popover-host" ref={host}>
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
				<Icon name="chevron" />
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
		{MORE_INLINE_COMMANDS.map((command) => {
			const icon = ICONS[command.id];
			return (
				<button
					type="button"
					key={command.id}
					className="toolbar-item"
					aria-pressed={isOn(command, format)}
					onMouseDown={(event) => {
						event.preventDefault();
						run(command.apply);
						setOpen(false);
					}}
				>
					{icon !== undefined && <Icon name={icon} />}
					<span>{command.label}</span>
				</button>
			);
		})}
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

export const FormatToolbar = ({
	format,
	run,
	placement = 'top',
}: FormatToolbarProps & { placement?: ToolbarPlacement }) => {
	const root = useRef<HTMLDivElement>(null);
	const { onKeyDown, stop } = useRoving(root);
	/** At most one panel is open, so which one is the whole of the state. */
	const [open, setOpen] = useState<string | null>(null);
	const opener = (id: string) => (wanted: boolean) => {
		setOpen(wanted ? id : null);
	};

	const group = (label: string, commands: readonly EditorCommand[]) => (
		<div className="toolbar-group" role="group" aria-label={label}>
			{commands.map((command) => (
				<ToolbarButton
					key={command.id}
					command={command}
					format={format}
					run={run}
					stop={stop(command.id)}
				/>
			))}
		</div>
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
			<div className="toolbar-group" role="group" aria-label="Text style">
				<TextStyleMenu
					format={format}
					run={run}
					open={open === 'text-style'}
					setOpen={opener('text-style')}
					stop={stop(FIRST_STOP)}
				/>
			</div>

			<div className="toolbar-group" role="group" aria-label="Text formatting">
				{PRIMARY_INLINE_COMMANDS.map((command) => (
					<ToolbarButton
						key={command.id}
						command={command}
						format={format}
						run={run}
						stop={stop(command.id)}
					/>
				))}
				<MoreFormatting
					format={format}
					run={run}
					open={open === 'more-formatting'}
					setOpen={opener('more-formatting')}
					stop={stop('more-formatting')}
				/>
			</div>

			{group('Lists', LIST_COMMANDS)}
			{group('Indentation', INDENT_COMMANDS)}
			{group('Insert', INSERT_COMMANDS)}

			<div className="toolbar-group" role="group" aria-label="Link">
				<LinkPanel
					format={format}
					run={run}
					open={open === 'link'}
					setOpen={opener('link')}
					stop={stop('link')}
				/>
			</div>
		</div>
	);
};
