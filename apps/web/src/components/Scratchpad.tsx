import {
	type PreviewLine,
	previewLineText,
	type PreviewMark,
	type PreviewMarker,
	type ScratchColor,
} from '@skysa/core';
import {
	Fragment,
	memo,
	type ReactNode,
	useCallback,
	useDeferredValue,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import { type NoteRecord } from '../store/db.js';
import { keepRows } from '../store/kept.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { isUnnamed } from '../store/notes.js';
import { cardLines, scratchGroups, scratchMarks, SCRATCHPAD_LABEL } from '../store/scratchpad.js';
import { handBack, SLICE_MS } from '../store/slices.js';
import { titleShown } from '../store/titles.js';
import { noteOpening, openingBlocks, openingLines } from '../store/visibleText.js';
import { CardEmbed, CardFiles, hasPictures } from './CardEmbed.js';
import { useCardMotion, useEasedHeight } from './cardMotion.js';
import { useElementWidth } from './layout.js';
import { CARD_MAX, guessHeight, placeCards } from './masonry.js';
import { CardMenu, ColorMenu, PinButton } from './ScratchControls.js';
import {
	besideOf,
	type Measure,
	type Span,
	useFocusedItem,
	useHeights,
	useScrollSpan,
	whenIdle,
} from './windowing.js';

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
						{t('scratchpad.take')}
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

/**
 * Where a card is on its wall, and how wide it is, once the wall has a width.
 * Numbers rather than a style, so a card that has not moved compares equal.
 */
interface CardPlace {
	readonly x: number;
	readonly y: number;
	readonly width: number;
}

/**
 * One note's card: its name if it has one, and the opening of what it says.
 *
 * Handed its note, its place and the scratchpad's handlers, which stay the same
 * from one draw to the next (`Scratchpad`), so it is drawn again only when one
 * of those changes: a card saved, or moved by one above it growing, and not
 * the wall around it.
 */
const CardView = ({
	note: row,
	open,
	liveEdits,
	x,
	y,
	width,
	measure,
	onFocusIn,
	onFocusOut,
	onOpen,
	onMark,
	onMove,
	onDelete,
}: Partial<CardPlace> & {
	note: NoteRecord;
	/** Open, and so not on the wall: its editor is where it went (`useCardMotion`). */
	open: boolean;
	liveEdits: LiveEdits | undefined;
	measure: Measure;
	/** The focus came into the card, or into one of its menus, or went out (`useFocusedItem`). */
	onFocusIn: (id: string) => void;
	onFocusOut: () => void;
	onOpen: (note: NoteRecord) => void;
	onMark: (note: NoteRecord, change: MarkChange) => void;
	onMove: ((note: NoteRecord) => void) | undefined;
	onDelete: (note: NoteRecord) => void;
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
		? titleShown(note.title)
		: first === undefined
			? t('scratchpad.card.emptyNote')
			: previewLineText(first) || t('scratchpad.card.pictureOnly');
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
			style={
				x === undefined || y === undefined
					? undefined
					: { width, transform: `translate(${String(x)}px, ${String(y)}px)` }
			}
			// From its menus too, which are portals: React's events come up
			// through them.
			onFocus={() => {
				onFocusIn(row.id);
			}}
			onBlur={onFocusOut}
		>
			<button
				type="button"
				className="scratch-card-open"
				data-card={row.id}
				onClick={() => {
					onOpen(row);
				}}
			>
				{named && <span className="scratch-card-title">{titleShown(note.title)}</span>}
				{hasPictures(lines) ? <CardFiles note={row}>{shown}</CardFiles> : shown}
				{!named && lines.length === 0 && (
					<span className="scratch-card-line muted">
						{t('scratchpad.card.emptyNote')}
					</span>
				)}
				{note.dirty === 1 && (
					<span
						className="dot"
						title={t('scratchpad.card.notSynced')}
						aria-label={t('scratchpad.card.notSynced')}
					/>
				)}
			</button>
			<div className="scratch-card-tools">
				<PinButton
					className="icon icon-quiet"
					pinned={marks.pinned}
					onToggle={() => {
						onMark(row, { pinned: marks.pinned ? undefined : true });
					}}
				/>
				<ColorMenu
					color={marks.color}
					onColor={(color) => {
						onMark(row, { color });
					}}
				/>
				<CardMenu
					name={name}
					onMove={
						onMove === undefined
							? undefined
							: () => {
									onMove(row);
								}
					}
					onDelete={() => {
						onDelete(row);
					}}
				/>
			</div>
		</article>
	);
};

const Card = memo(CardView);

/**
 * Above this many cards, the scratchpad draws only those near the screen
 * (`windowing.ts`, #275; docs/ARCHITECTURE.md §7, "Large libraries").
 */
export const WALL_WINDOWED_ABOVE = 100;

/**
 * How many cards a windowed wall draws before it has a width to place them
 * by: about two screens of a wide one, where a phone's shows fewer.
 */
const FIRST_CARDS = 40;

/**
 * How many cards a windowed wall measures at a time, ahead of the screen: few
 * enough that drawing them is no long task on a slow phone.
 */
const AHEAD = 8;

/** Where the wall is windowed: the scroller it is drawn in, and the cards drawn wherever they are. */
interface WallWindow {
	readonly scroller: HTMLElement | null;
	readonly kept: ReadonlySet<string>;
	/** Whether either wall has measured a card, and how a wall says it has. */
	readonly measuring: boolean;
	readonly onMeasured: () => void;
}

/**
 * Each card's height guessed at a width, kept with the note it was guessed
 * for: a note unchanged since the read before is the object it was then
 * (`keptRows`), so a card is guessed once, and again only once it changes or
 * the cards are another width.
 */
const guessed = new WeakMap<NoteRecord, Readonly<{ width: number; height: number }>>();

/** A card's height as guessed before at `width`, if it was. */
const guessedAt = (note: NoteRecord, width: number): number | undefined => {
	const kept = guessed.get(note);
	return kept?.width === width ? kept.height : undefined;
};

/** A card's height guessed now at `width`, and kept. */
const guessNow = (note: NoteRecord, width: number): number => {
	const height = guessHeight(
		{ title: !isUnnamed(note), lines: openingLines(note.body).slice(0, 12) },
		width
	);
	guessed.set(note, { width, height });
	return height;
};

/**
 * The heights of the cards from the top that have one to be placed by,
 * measured or guessed, guessing while a slice lasts (`SLICE_MS`). A guess
 * reads the card's text, which for a first look at six hundred cards was a
 * third of a second on a phone, in the task that drew the scratchpad (#275).
 * A card is placed by the heights of every card before it, so the wall is
 * placed from the top down, and ends at the first card not guessed yet.
 *
 * Only what has never been placed waits for a slice. Cards arriving above
 * cards with a height already — a sync's — are guessed now, whatever the
 * clock says: a wall ending at the first of them let go of every card after
 * it, the one the focus was in among them, and fell short of where the user
 * was scrolled to.
 */
const heightsFromTop = (
	notes: readonly NoteRecord[],
	measured: ReadonlyMap<string, number>,
	width: number
): number[] => {
	const until = performance.now() + SLICE_MS;
	const heightOf = (note: NoteRecord): number | undefined =>
		measured.get(note.id) ?? guessedAt(note, width);
	const known = notes.reduce((end, note, at) => (heightOf(note) === undefined ? end : at + 1), 0);
	// At least one guess a slice, so a slow clock cannot keep the wall still.
	const slice = { over: false };
	const ends = notes.findIndex((note, at) => {
		if (heightOf(note) !== undefined) return false;
		if (slice.over && at >= known) return true;
		guessNow(note, width);
		slice.over = performance.now() >= until;
		return false;
	});
	return notes.slice(0, ends === -1 ? notes.length : ends).map((note) => heightOf(note) ?? 0);
};

/** Whether a card at `y`, `height` tall, meets `span`. */
const meets = (y: number, height: number, { top, bottom }: Span): boolean =>
	y < bottom && y + height > top;

/**
 * One wall of cards: the pinned, or the rest. Placed by `placeCards` once the
 * wall has a width; until then — and where nothing is laid out, as in a test —
 * in a grid of their own, which is near enough for the first frame. Windowed,
 * it draws the cards placed near the screen and those kept, and holds the
 * height of all of them.
 */
const Wall = ({
	notes,
	label,
	labelled,
	card,
	windowed,
}: {
	notes: readonly NoteRecord[];
	label: string;
	/** Whether the label is shown, which it is only beside the other wall. */
	labelled: boolean;
	card: (note: NoteRecord, place: CardPlace | undefined, measure: Measure) => ReactNode;
	windowed: WallWindow | undefined;
}) => {
	const labelId = useId();
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const width = useElementWidth(element);
	// Each card's height, as drawn, by note id: what the wall places them by,
	// and when each was last measured.
	const { heights, measure, told, seen } = useHeights({ stamped: true });
	// A slice of guesses each time the page has handed the thread back. A
	// slice a wall: with pinned cards, the two walls' share a task.
	const [slices, setSlices] = useState(0);
	const placed = useMemo(() => {
		if (width === undefined) return undefined;
		// Read only to place the cards again, as each slice is done.
		void slices;
		const tall = heightsFromTop(notes, heights, Math.min(CARD_MAX, width / 2));
		return { wall: placeCards(tall, width), tall };
	}, [notes, heights, width, slices]);
	const unguessed = placed !== undefined && placed.tall.length < notes.length;
	useEffect(() => {
		if (!unguessed) return undefined;
		const gone = { current: false };
		void handBack().then(() => {
			if (!gone.current) setSlices((done) => done + 1);
		});
		return () => {
			gone.current = true;
		};
	}, [unguessed, placed]);
	const wall = placed?.wall;
	// What was measured before the cards were this wide is to be measured again.
	const [measuredAt, setMeasuredAt] = useState({ cardWidth: wall?.cardWidth, told });
	if (measuredAt.cardWidth !== wall?.cardWidth)
		setMeasuredAt({ cardWidth: wall?.cardWidth, told });
	// Not listened for at all where every card is drawn.
	const span = useScrollSpan(windowed?.scroller ?? null, windowed === undefined ? null : element);
	/** Whether a card has a place on the wall yet: none until it has been guessed. */
	const unplaced = (at: number): boolean => placed !== undefined && at >= placed.tall.length;
	const near = (note: NoteRecord, at: number): boolean => {
		if (unplaced(at)) return false;
		if (windowed === undefined || windowed.kept.has(note.id)) return true;
		// Nothing laid out at all draws everything, as it does once placed.
		if (placed === undefined) return span === undefined || at < FIRST_CARDS;
		const place = placed.wall.places[at];
		return (
			span === undefined || place === undefined || meets(place.y, placed.tall[at] ?? 0, span)
		);
	};
	// Every card measured ahead of the screen, a few at a time while the page
	// has nothing else to do. A card is placed by the heights of the cards
	// before it, so one measured only as it was scrolled to moved the cards
	// after it, there on the screen, into other columns; measured ahead, each
	// is placed where it will stay. Only once a card has been measured, on
	// either wall (the rest can be wholly under pinned cards that fill the
	// screen): until then, as in a test, none can be.
	const measuredOne = seen.size > 0;
	const onMeasured = windowed?.onMeasured;
	useEffect(() => {
		if (measuredOne) onMeasured?.();
	}, [measuredOne, onMeasured]);
	const waiting = JSON.stringify(
		windowed === undefined || placed === undefined || !windowed.measuring
			? []
			: notes
					.filter(
						(note, at) =>
							(seen.get(note.id) ?? 0) <= measuredAt.told &&
							!near(note, at) &&
							!unplaced(at)
					)
					.slice(0, AHEAD)
					.map((note) => note.id)
	);
	const [ahead, setAhead] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(
		() =>
			whenIdle(() => {
				const next = JSON.parse(waiting) as readonly string[];
				setAhead((current) =>
					next.length === 0 && current.size === 0 ? current : new Set(next)
				);
			}),
		[waiting]
	);
	// Listed to be measured while it had a place: none is drawn without one.
	const drawn = (note: NoteRecord, at: number) =>
		near(note, at) || (!unplaced(at) && ahead.has(note.id));
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
					if (!drawn(note, at)) return null;
					const place = wall?.places[at];
					return card(
						note,
						wall === undefined || place === undefined
							? undefined
							: { x: place.x, y: place.y, width: wall.cardWidth },
						measure
					);
				})}
			</div>
		</section>
	);
};

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
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	/** The card the focus is in, or in its menus: drawn wherever it is scrolled to. */
	const { focusedId, focusIn, focusOut } = useFocusedItem();
	// The card open, or open last: the editor goes back into it as it closes,
	// and the focus comes back to it (`useCardMotion`, `useFocusBack`).
	const [openLast, setOpenLast] = useState(openId);
	if (openId !== undefined && openId !== openLast) setOpenLast(openId);
	const cards = useMemo(
		() => scratchGroups((notes ?? []).filter((note) => note.id !== takingId)),
		[notes, takingId]
	);
	// A pinned card's marks are asked for on every read (`scratchGroups`), an
	// unnamed card's block as its height is guessed, and the opening of a card
	// drawn again, or not measured yet.
	keepRows('scratchpad', notes?.length ?? 0);
	const both = cards.pinned.length > 0 && cards.others.length > 0;
	// The handlers this is given are made again on each draw of the page. The
	// cards are handed these instead, which stay the same and call the ones
	// given last, as the note list's rows are (`NoteList`).
	const given = useRef({ onOpen, onMark, onMove, onDelete });
	useLayoutEffect(() => {
		given.current = { onOpen, onMark, onMove, onDelete };
	});
	const open = useCallback((note: NoteRecord) => {
		given.current.onOpen(note);
	}, []);
	const mark = useCallback((note: NoteRecord, change: MarkChange) => {
		given.current.onMark(note, change);
	}, []);
	const move = useCallback((note: NoteRecord) => {
		given.current.onMove?.(note);
	}, []);
	const remove = useCallback((note: NoteRecord) => {
		given.current.onDelete(note);
	}, []);
	// The cards in the order they are on the page, which Tab goes through.
	const order = useMemo(() => [...cards.pinned, ...cards.others], [cards]);
	// Whether either wall has measured a card (`Wall`).
	const [measuring, setMeasuring] = useState(false);
	const measured = useCallback(() => {
		setMeasuring(true);
	}, []);
	const windowed =
		order.length > WALL_WINDOWED_ABOVE
			? {
					scroller,
					measuring,
					onMeasured: measured,
					// And the cards either side of the one the focus is in.
					kept: new Set(
						[openLast, focusedId, ...besideOf(order, focusedId)].filter(
							(id) => id !== undefined
						)
					),
				}
			: undefined;
	const card = (note: NoteRecord, place: CardPlace | undefined, measure: Measure) => (
		<Card
			key={note.id}
			note={note}
			open={note.id === openId}
			liveEdits={liveEdits}
			{...place}
			measure={measure}
			// Followed even where every card is drawn, so that one the focus is
			// in stays when a sync takes the wall past the number windowed.
			onFocusIn={focusIn}
			onFocusOut={focusOut}
			onOpen={open}
			onMark={mark}
			onMove={onMove === undefined ? undefined : move}
			onDelete={remove}
		/>
	);
	const empty = notes !== undefined && cards.pinned.length + cards.others.length === 0;

	return (
		// No heading: its row in the sidebar, or the bar in a compact window,
		// says where the user is.
		<section ref={setScroller} className="scratchpad" aria-label={SCRATCHPAD_LABEL}>
			<div className="scratchpad-scroll">
				<TakeNote editor={editor} onTake={onTake} onClose={onCloseTake} />
				{empty && (
					<p className="muted placeholder scratch-empty">
						<Icon name="scratchpad" />
						{t('scratchpad.empty')}
					</p>
				)}
				{cards.pinned.length > 0 && (
					<Wall
						notes={cards.pinned}
						label={t('scratchpad.pinned')}
						labelled={both}
						card={card}
						windowed={windowed}
					/>
				)}
				{cards.others.length > 0 && (
					<Wall
						notes={cards.others}
						label={t('scratchpad.others')}
						labelled={both}
						card={card}
						windowed={windowed}
					/>
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
				aria-label={t('scratchpad.note')}
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
