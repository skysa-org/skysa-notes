import {
	type PreviewLine,
	previewLineText,
	type PreviewMark,
	type PreviewMarker,
	type ScratchColor,
} from '@skysa/core';
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useCallback,
	useDeferredValue,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../editor/icons.js';
import { type NoteRecord } from '../store/db.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { isUnnamed } from '../store/notes.js';
import { cardLines, scratchGroups, scratchMarks, SCRATCHPAD_LABEL } from '../store/scratchpad.js';
import { noteOpening, openingBlocks, openingLines } from '../store/visibleText.js';
import { CardEmbed, CardFiles, hasPictures } from './CardEmbed.js';
import { useCardMotion, useEasedHeight } from './cardMotion.js';
import { useElementWidth } from './layout.js';
import { CARD_MAX, guessHeight, placeCards } from './masonry.js';
import { CardMenu, ColorMenu, PinButton } from './ScratchControls.js';

/**
 * The scratchpad (docs/ARCHITECTURE.md §7, "The scratchpad"): a box to take a
 * note in, and the source's scratch notes under it as a wall of cards, the
 * pinned first. A card opens its note; the route decides where the editor for
 * it goes, and hands the one for a note being taken back in as `editor`.
 */

/** A change to a card's marks: a key given is set, or taken away as `undefined`. */
export interface MarkChange {
	pinned?: true | undefined;
	color?: ScratchColor | undefined;
}

export interface ScratchpadProps {
	/** The source's scratch notes, newest made first; `undefined` while read. */
	notes: readonly NoteRecord[] | undefined;
	/** The note being taken, which is not a card until it is closed. */
	takingId: string | undefined;
	/** The editor for the note being taken, in place of the prompt. */
	editor: ReactNode;
	/** Begin taking a note. */
	onTake: () => void;
	/** Stop taking it: Escape, or a press anywhere outside the box. */
	onCloseTake: () => void;
	/** The card open, if one is: the focus comes back to it when it closes. */
	openId: string | undefined;
	onOpen: (note: NoteRecord) => void;
	onMark: (note: NoteRecord, change: MarkChange) => void;
	/** Make a card a note in a notebook; unsaid while something else is moving. */
	onMove: ((note: NoteRecord) => void) | undefined;
	onDelete: (note: NoteRecord) => void;
	liveEdits: LiveEdits | undefined;
}

/**
 * Where a press does not close the note being taken: the box itself, and what
 * opens over the page from inside it — a menu, the inline toolbar, a dialog.
 */
const INSIDE_TAKING = '.take-note, .toolbar-panel, .inline-toolbar, .modal-backdrop';

/**
 * Whether a key closes a scratch note's editor: Escape, unless something in it
 * answered the key first — a panel of its toolbar shutting. The text itself
 * is the exception, since ProseMirror answers every Escape there (it selects
 * the block around the cursor), and Escape in a note's text is the user
 * leaving it.
 */
const closesOnEscape = (event: KeyboardEvent): boolean =>
	event.key === 'Escape' &&
	(!event.defaultPrevented ||
		(event.target instanceof Element && event.target.closest('.ProseMirror') !== null));

/** The field that keeps the focus for the editor (`TakeNote`), which may take it from there. */
export const FOCUS_KEEPER = 'focus-keeper';

/** The note being taken closes on Escape, and on a press anywhere else. */
const useCloseTaking = (taking: boolean, box: HTMLElement | null, onClose: () => void) => {
	const close = useRef(onClose);
	useEffect(() => {
		close.current = onClose;
	}, [onClose]);
	useEffect(() => {
		if (!taking || box === null) return undefined;
		const onPress = (event: PointerEvent) => {
			if (
				!(event.target instanceof Element) ||
				event.target.closest(INSIDE_TAKING) !== null
			) {
				return;
			}
			close.current();
		};
		const onKey = (event: KeyboardEvent) => {
			if (closesOnEscape(event)) close.current();
		};
		document.addEventListener('pointerdown', onPress);
		box.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onPress);
			box.removeEventListener('keydown', onKey);
		};
	}, [taking, box]);
};

/**
 * The box at the top: one line that says what it is for, and once it is
 * pressed the editor for a new note in its place.
 */
const TakeNote = ({
	editor,
	onTake,
	onClose,
}: {
	editor: ReactNode;
	onTake: () => void;
	onClose: () => void;
}) => {
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	const [inner, setInner] = useState<HTMLDivElement | null>(null);
	const keeper = useRef<HTMLInputElement>(null);
	const taking = editor !== undefined && editor !== null;
	useCloseTaking(taking, box, onClose);
	useEasedHeight(box, inner, taking);
	return (
		<div ref={setBox} className={taking ? 'take-note taking' : 'take-note'}>
			<div ref={setInner} className="take-note-inner">
				{/* Holds the focus, and with it a phone's keyboard, from the press
				    until the editor it opens is there to take it: a phone opens its
				    keyboard only for a field focused in the press itself. */}
				<input ref={keeper} className={FOCUS_KEEPER} tabIndex={-1} aria-hidden="true" />
				{taking ? (
					editor
				) : (
					<button
						type="button"
						className="take-note-prompt"
						onClick={() => {
							keeper.current?.focus();
							onTake();
						}}
					>
						Take a note…
					</button>
				)}
			</div>
		</div>
	);
};

/** A note's opening lines after its name and the date it was made, as a list row has them (`noteOpening`). */
const opening = (
	body: string,
	note: Readonly<{ title: string; createdAt: number }>,
	options: { keep: boolean }
): readonly PreviewLine[] => {
	const lines = openingBlocks(body, options);
	const after = noteOpening(lines.map(previewLineText), note);
	return lines.slice(lines.length - after.length);
};

/** The element each mark is drawn in. */
const MARK_TAG = {
	strong: 'strong',
	emphasis: 'em',
	delete: 's',
	code: 'code',
} as const satisfies Record<Exclude<PreviewMark, 'link'>, string>;

/** Words in their marks. A link is only drawn as one: the card is a button, and one press opens it. */
const marked = (text: string, marks: readonly PreviewMark[]): ReactNode =>
	marks.reduce<ReactNode>((inside, mark) => {
		if (mark === 'link') return <span className="scratch-card-link">{inside}</span>;
		const Tag = MARK_TAG[mark];
		return <Tag>{inside}</Tag>;
	}, text);

/** A list's bullets by depth, as a browser draws them: disc, circle, square. */
const BULLETS = ['•', '◦', '▪'] as const;

/** What an item's first line starts with. Out of the card's name, which is its words. */
const Marker = ({ marker, depth }: { marker: PreviewMarker; depth: number }) => {
	if (marker.kind === 'task') {
		return (
			<span className="scratch-card-box" data-checked={marker.checked} aria-hidden="true">
				{marker.checked && <Icon name="check" />}
			</span>
		);
	}
	return (
		<span className="scratch-card-marker" aria-hidden="true">
			{marker.kind === 'number'
				? `${String(marker.value)}.`
				: BULLETS[(depth - 1) % BULLETS.length]}
		</span>
	);
};

/**
 * One line of a card, set as it is in the note: its marks, and an item's
 * bullet, number or box before its words, which wrap under themselves. A
 * line of a list is in by its depth, and an item's later lines by one more,
 * to stand under its words.
 */
const CardLine = ({ line }: { line: PreviewLine }) => {
	const indent = line.marker === undefined ? line.depth : line.depth - 1;
	return (
		<span
			className="scratch-card-line"
			data-heading={line.heading}
			data-quote={line.quote}
			data-code={line.code}
			data-done={line.marker?.kind === 'task' && line.marker.checked ? true : undefined}
			style={indent > 0 ? { paddingInlineStart: `${String(indent * 1.4)}em` } : undefined}
		>
			{line.marker !== undefined && <Marker marker={line.marker} depth={line.depth} />}
			<span className="scratch-card-words">
				{line.runs.map((run, at) => (
					<Fragment key={at}>
						{run.embed === undefined ? (
							marked(run.text, run.marks)
						) : (
							<CardEmbed embed={run.embed} words={run.text} />
						)}
					</Fragment>
				))}
			</span>
		</span>
	);
};

/** One note's card: its name if it has one, and the opening of what it says. */
const Card = ({
	note: row,
	open,
	liveEdits,
	style,
	measure,
	onOpen,
	onMark,
	onMove,
	onDelete,
}: {
	note: NoteRecord;
	/** Open, and so not on the wall: its editor is where it went (`useCardMotion`). */
	open: boolean;
	liveEdits: LiveEdits | undefined;
	style: CSSProperties | undefined;
	measure: Measure;
	onOpen: () => void;
	onMark: (change: MarkChange) => void;
	onMove: (() => void) | undefined;
	onDelete: () => void;
}) => {
	// Deferred, as a note list row is: the card is a parse of what is typed.
	const note = shownNote(row, useDeferredValue(useLiveEdit(liveEdits, row)));
	const marks = scratchMarks(row);
	// A name its first heading gives it shows through as it is typed.
	const named = !isUnnamed(row) || note.title !== row.title;
	const typing = note.body !== row.body;
	const lines = cardLines(opening(note.body, note, { keep: !typing }));
	const first = lines[0];
	const name = named
		? note.title
		: first === undefined
			? 'Empty note'
			: previewLineText(first) || 'Picture';
	const shown = lines.map((line, at) => (
		// Lines of one note, in order, and drawn again whole when it changes.
		<CardLine key={at} line={line} />
	));
	return (
		<article
			ref={measure}
			className="scratch-card"
			data-id={row.id}
			data-color={marks.color}
			data-open={open || undefined}
			style={style}
		>
			<button type="button" className="scratch-card-open" data-card={row.id} onClick={onOpen}>
				{named && <span className="scratch-card-title">{note.title}</span>}
				{hasPictures(lines) ? <CardFiles note={row}>{shown}</CardFiles> : shown}
				{!named && lines.length === 0 && (
					<span className="scratch-card-line muted">Empty note</span>
				)}
				{note.dirty === 1 && (
					<span className="dot" title="Not yet synced" aria-label="Not yet synced" />
				)}
			</button>
			<div className="scratch-card-tools">
				<PinButton
					className="icon icon-quiet"
					pinned={marks.pinned}
					onToggle={() => {
						onMark({ pinned: marks.pinned ? undefined : true });
					}}
				/>
				<ColorMenu
					color={marks.color}
					onColor={(color) => {
						onMark({ color });
					}}
				/>
				<CardMenu name={name} onMove={onMove} onDelete={onDelete} />
			</div>
		</article>
	);
};

/**
 * Each card's height, as drawn, by note id: what the wall places them by. One
 * observer for every card, and a new map only when a height has changed.
 */
const useCardHeights = () => {
	const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
	const observer = useMemo(
		() =>
			typeof ResizeObserver === 'undefined'
				? undefined
				: new ResizeObserver((entries) => {
						setHeights((current) => {
							const changed = entries
								.map(
									(entry) =>
										[
											(entry.target as HTMLElement).dataset.id ?? '',
											entry.borderBoxSize[0]?.blockSize ??
												entry.target.getBoundingClientRect().height,
										] as const
								)
								.filter(([id, height]) => current.get(id) !== height);
							return changed.length === 0
								? current
								: new Map([...current, ...changed]);
						});
					}),
		[]
	);
	useEffect(
		() => () => {
			observer?.disconnect();
		},
		[observer]
	);
	const measure = useCallback(
		(element: HTMLElement | null) => {
			if (element === null || observer === undefined) return undefined;
			observer.observe(element);
			return () => {
				observer.unobserve(element);
			};
		},
		[observer]
	);
	return { heights, measure };
};

/**
 * One wall of cards: the pinned, or the rest. Placed by `placeCards` once the
 * wall has a width; until then — and where nothing is laid out, as in a test —
 * in a grid of their own, which is near enough for the first frame.
 */
const Wall = ({
	notes,
	label,
	labelled,
	card,
}: {
	notes: readonly NoteRecord[];
	label: string;
	/** Whether the label is shown, which it is only beside the other wall. */
	labelled: boolean;
	card: (note: NoteRecord, style: CSSProperties | undefined, measure: Measure) => ReactNode;
}) => {
	const labelId = useId();
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const width = useElementWidth(element);
	const { heights, measure } = useCardHeights();
	const wall = useMemo(() => {
		if (width === undefined) return undefined;
		const guessWidth = Math.min(CARD_MAX, width / 2);
		return placeCards(
			notes.map(
				(note) =>
					heights.get(note.id) ??
					guessHeight(
						{ title: !isUnnamed(note), lines: openingLines(note.body).slice(0, 12) },
						guessWidth
					)
			),
			width
		);
	}, [notes, heights, width]);
	return (
		<section className="scratch-group" aria-labelledby={labelled ? labelId : undefined}>
			{labelled && (
				// Over the first column, wherever centring the columns put it.
				<h3
					id={labelId}
					className="scratch-group-name"
					style={wall === undefined ? undefined : { paddingInlineStart: wall.left }}
				>
					{label}
				</h3>
			)}
			<div
				ref={setElement}
				className={wall === undefined ? 'scratch-wall' : 'scratch-wall placed'}
				style={wall === undefined ? undefined : { height: wall.height }}
			>
				{notes.map((note, at) => {
					const place = wall?.places[at];
					return card(
						note,
						wall === undefined || place === undefined
							? undefined
							: {
									width: wall.cardWidth,
									transform: `translate(${String(place.x)}px, ${String(place.y)}px)`,
								},
						measure
					);
				})}
			</div>
		</section>
	);
};

type Measure = (element: HTMLElement | null) => (() => void) | undefined;

/** The card that was open has the focus back when it closes, if nothing else took it. */
const useFocusBack = (openId: string | undefined) => {
	const was = useRef(openId);
	useEffect(() => {
		const closed = was.current;
		was.current = openId;
		if (closed === undefined || openId !== undefined) return;
		const active = document.activeElement;
		if (active !== null && active !== document.body) return;
		document.querySelector<HTMLElement>(`[data-card="${CSS.escape(closed)}"]`)?.focus();
	}, [openId]);
};

export const Scratchpad = ({
	notes,
	takingId,
	editor,
	onTake,
	onCloseTake,
	openId,
	onOpen,
	onMark,
	onMove,
	onDelete,
	liveEdits,
}: ScratchpadProps) => {
	useFocusBack(openId);
	const cards = useMemo(
		() => scratchGroups((notes ?? []).filter((note) => note.id !== takingId)),
		[notes, takingId]
	);
	const both = cards.pinned.length > 0 && cards.others.length > 0;
	const card = (note: NoteRecord, style: CSSProperties | undefined, measure: Measure) => (
		<Card
			key={note.id}
			note={note}
			open={note.id === openId}
			liveEdits={liveEdits}
			style={style}
			measure={measure}
			onOpen={() => {
				onOpen(note);
			}}
			onMark={(change) => {
				onMark(note, change);
			}}
			onMove={
				onMove === undefined
					? undefined
					: () => {
							onMove(note);
						}
			}
			onDelete={() => {
				onDelete(note);
			}}
		/>
	);
	const empty = notes !== undefined && cards.pinned.length + cards.others.length === 0;

	return (
		// No heading: its row in the sidebar, or the bar in a compact window,
		// says where the user is.
		<section className="scratchpad" aria-label={SCRATCHPAD_LABEL}>
			<div className="scratchpad-scroll">
				<TakeNote editor={editor} onTake={onTake} onClose={onCloseTake} />
				{empty && (
					<p className="muted placeholder scratch-empty">
						<Icon name="scratchpad" />
						Notes you take here show up as cards.
					</p>
				)}
				{cards.pinned.length > 0 && (
					<Wall notes={cards.pinned} label="Pinned" labelled={both} card={card} />
				)}
				{cards.others.length > 0 && (
					<Wall notes={cards.others} label="Others" labelled={both} card={card} />
				)}
			</div>
		</section>
	);
};

/**
 * A card open on a wide screen: its editor in a dialog over the scratchpad.
 * The app behind it is `inert` (the route's), so the focus stays in it; a press
 * on the backdrop and an Escape nothing inside has answered close it, as Back
 * does. Escape is heard on the dialog's own element rather than through React,
 * so that one pressed in a menu the editor opened over the page — a portal,
 * whose React events would bubble here — is the menu's alone.
 */
export const ScratchModal = ({
	id,
	color,
	onClose,
	children,
}: {
	/** The note open: the card it grows out of, and goes back into. */
	id: string;
	color: ScratchColor | undefined;
	onClose: () => void;
	children: ReactNode;
}) => {
	const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
	const [backdrop, setBackdrop] = useState<HTMLDivElement | null>(null);
	useCardMotion(backdrop, dialog, id, { dim: true });
	const close = useRef(onClose);
	useEffect(() => {
		close.current = onClose;
	}, [onClose]);

	useEffect(() => {
		if (dialog === null) return;
		if (!dialog.contains(document.activeElement)) dialog.focus();
	}, [dialog]);

	useEffect(() => {
		if (dialog === null || backdrop === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (closesOnEscape(event)) close.current();
		};
		const onPress = (event: PointerEvent) => {
			if (event.target === backdrop) close.current();
		};
		dialog.addEventListener('keydown', onKey);
		backdrop.addEventListener('pointerdown', onPress);
		return () => {
			dialog.removeEventListener('keydown', onKey);
			backdrop.removeEventListener('pointerdown', onPress);
		};
	}, [dialog, backdrop]);

	return createPortal(
		<div ref={setBackdrop} className="modal-backdrop scratch-backdrop">
			<div
				ref={setDialog}
				className="scratch-modal"
				role="dialog"
				aria-modal="true"
				aria-label="Scratch note"
				data-color={color}
				tabIndex={-1}
			>
				{children}
			</div>
		</div>,
		document.body
	);
};

/**
 * A card open in a compact window: its note pane, the whole window under the
 * bar, grown out of the card and gone back into it (`useCardMotion`). A box of
 * no size of its own (`display: contents`), so the pane in it is the column's
 * as it is everywhere else.
 */
export const CardSheet = ({ id, children }: { id: string; children: ReactNode }) => {
	const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
	const pane = sheet?.firstElementChild;
	useCardMotion(sheet, pane instanceof HTMLElement ? pane : null, id);
	return (
		<div ref={setSheet} className="card-sheet">
			{children}
		</div>
	);
};
