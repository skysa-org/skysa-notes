import { ROOT } from '@skysa/core';
import {
	memo,
	type ReactNode,
	useCallback,
	useDeferredValue,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

import { rich } from '../i18n/rich.js';
import { t } from '../i18n/t.js';
import { type NoteRecord } from '../store/db.js';
import { keepRows } from '../store/kept.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { type Renamings, shownFolder, useRenaming } from '../store/renaming.js';
import { titleShown } from '../store/titles.js';
import { byParent, folderLabel } from '../store/tree.js';
import { noteOpening, openingLines } from '../store/visibleText.js';
import { editedAt } from './editedAt.js';
import { FloatingMenu, type MenuPoint, menuPoint, type OptionsMenuItem } from './OptionsMenu.js';
import { RowOptions } from './RowOptions.js';
import { indicesIn, type Measure, topsOf, useHeights, useScrollSpan } from './windowing.js';

/**
 * The middle pane: the notes in the selected notebook, newest first by when
 * each was made (`listNotes`), with any pinned on this device above the rest
 * (`store/pins.ts`); then the notes in the notebooks inside it, at any depth,
 * each notebook's under its name (`listedUnder`). Each row still says when its note was last
 * edited; that is what it says, not where it sits. A row says what is being
 * typed into its note as it is typed, not once autosave has stored it
 * (`store/liveEdits.ts`), so the list and the editor beside it never disagree.
 *
 * A list longer than `WINDOWED_ABOVE` draws only its rows near the screen
 * (`windowing.ts`; docs/ARCHITECTURE.md §7, "Large libraries"), and those the
 * user is at wherever they are: the selected, the focused, the one being
 * dragged and the one whose menu is open.
 *
 * It used to show a search's answers too, in place of the notebook's notes.
 * They hang from the search field now (`SearchField`), so the notebook the user
 * was reading stays where it was behind them and there is no pane to find the
 * way back from.
 */

export interface NoteListProps {
	/**
	 * The notebook's own notes first, then each notebook's inside it, a
	 * notebook's together (`listedUnder`): each run of a notebook inside it is
	 * listed under that notebook's name.
	 */
	notes: NoteRecord[] | undefined;
	selectedNoteId: string | undefined;
	/** The note, so one from a notebook inside this one can open that notebook. */
	onSelectNote: (note: NoteRecord) => void;
	onCreateNote: () => void;
	/**
	 * Ask the sidebar for a new notebook, for the empty state's "Create a
	 * notebook". Without it the words are plain text.
	 */
	onCreateNotebook?: () => void;
	/**
	 * The open folder, or undefined when nothing is open. The root is a folder
	 * like any other here — it just holds the loose notes rather than a notebook.
	 */
	folderPath: string | undefined;
	/**
	 * False while the store is still loading — the notebooks or the count of
	 * loose notes — so an app that is merely slow is not mistaken for an empty
	 * one and told to create a notebook it may already have notes outside of.
	 */
	storeLoaded: boolean;
	/**
	 * A row can be dragged into a notebook in the sidebar. The note is picked up
	 * here and put down there, so what is in the air is the route's state and
	 * not this pane's — see `store/rearrange.ts`.
	 */
	onPickUpNote?: (note: NoteRecord) => void;
	/** The drag ended without a drop. */
	onCancelMove?: () => void;
	/** Which of these rows is the one in the air, if any. */
	movingNoteId?: string;
	/**
	 * The row for a note begun and not stored yet (`draftNote`). It cannot be
	 * dragged or deleted: there is nothing yet to move, and leaving it unedited
	 * is what deleting it would do.
	 */
	unsavedNoteId?: string | undefined;
	/** What is being typed into a note and not saved yet, to show in its row. */
	liveEdits?: LiveEdits;
	/**
	 * What a note's row offers, from its `⋯` and from a right-click: the
	 * note's own menu (`noteMenuItems`), about that note. Without it the `⋯` is
	 * disabled and a right-click opens the browser's menu.
	 */
	menuFor?: (note: NoteRecord) => readonly OptionsMenuItem[];
	/** A notebook being renamed, so the heading says what is typed. */
	renamings?: Renamings;
	/**
	 * The notes pinned to the top of the list on this device (`store/pins.ts`),
	 * to tint. The list comes in with them first (`pinnedFirst`).
	 */
	pinnedNoteIds?: ReadonlySet<string>;
}

/**
 * What to show instead of the list. Pulled out of the markup because it is the
 * only place the empty states — still loading, nowhere to put a note, and an
 * empty notebook — have to be told apart.
 *
 * An empty state that says what to do next offers to do it: a press on the
 * words, not a hunt for the `+` they describe. The root is not one of those
 * places — loose notes are imported, never created here.
 */
const placeholderFor = ({
	notes,
	folderPath,
	storeLoaded,
	onCreateNote,
	onCreateNotebook,
}: Pick<
	NoteListProps,
	'notes' | 'folderPath' | 'storeLoaded' | 'onCreateNote' | 'onCreateNotebook'
>): ReactNode => {
	if (folderPath === undefined) {
		if (!storeLoaded) return t('notes.list.loading');
		return rich('notes.list.noNotebook', {
			create: (words) =>
				onCreateNotebook === undefined ? (
					words
				) : (
					<button type="button" className="link-button" onClick={onCreateNotebook}>
						{words}
					</button>
				),
		});
	}
	if (notes === undefined) return t('notes.list.loading');
	if (notes.length > 0) return undefined;
	if (folderPath === ROOT) return t('notes.list.empty');
	return rich('notes.list.emptyCreate', {
		create: (words) => (
			<button type="button" className="link-button" onClick={onCreateNote}>
				{words}
			</button>
		),
	});
};

/**
 * What stands between two lines of a note in its row. The row is one line of
 * text, and a space there made two lines read as one sentence: "Buy milk" over
 * "Call the bank" came out as "Buy milk Call the bank". A line is whatever the
 * note shows as one — a paragraph, a heading, a list item, a line broken inside
 * a paragraph (`previewLines`).
 */
const LINE_BREAK = ' | ';

const preview = (note: NoteRecord, keep: boolean): string => {
	const text = noteOpening(openingLines(note.body, { keep }), note).join(LINE_BREAK);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

/**
 * The opening of a note, or nothing at all when it has none to show. `typing`
 * for a body being typed, which is read once and not kept (`visibleLines`).
 */
const Preview = ({ note, typing }: { note: NoteRecord; typing: boolean }) => {
	const text = preview(note, !typing);
	return text === '' ? null : <span className="note-preview">{text}</span>;
};

/**
 * A row is handed its note and what it shows of the list's state as values,
 * and the list's handlers as functions that stay the same from one draw to the
 * next (`NoteList`), so it is drawn again only when one of those changes: an
 * autosave redraws the row of the note saved, and not the thousand beside it.
 */
interface NoteRowProps {
	note: NoteRecord;
	selected: boolean;
	onSelect: (note: NoteRecord) => void;
	liveEdits: LiveEdits | undefined;
	/** Missing where the pane was rendered without anywhere to drag a note to. */
	onPickUp?: ((note: NoteRecord) => void) | undefined;
	onCancelMove: () => void;
	/** True while this is the row being moved. */
	moving: boolean;
	/**
	 * What its `⋯` and its right-click offer, made when one is opened. Missing
	 * where the note has no menu: a note not stored yet, or a list given none.
	 */
	menuFor?: (note: NoteRecord) => readonly OptionsMenuItem[];
	/** A right-click, where the note has a menu. */
	onMenu?: (note: NoteRecord, at: MenuPoint) => void;
	/** Pinned to the top of the list on this device. */
	pinned: boolean;
	/** Where the list is windowed: how its row is measured, and where in its run it is. */
	windowed?: Windowed | undefined;
}

/** What a row of a windowed list is told (`NoteList`). */
interface Windowed {
	readonly measure: Measure;
	/** How many rows its run has, all of them, drawn or not. */
	readonly of: number;
	/** Its place in the run, from 1. */
	readonly at: number;
	/** The focus came into the row, or into its menu, or went out. */
	readonly onFocus: (id: string | undefined) => void;
}

const NoteRowView = ({
	note: row,
	selected,
	onSelect,
	liveEdits,
	onPickUp,
	onCancelMove,
	moving,
	menuFor,
	onMenu,
	pinned,
	windowed,
}: NoteRowProps) => {
	// Deferred, so a keystroke is never kept waiting on a row's redraw: the
	// preview is a parse.
	const note = shownNote(row, useDeferredValue(useLiveEdit(liveEdits, row)));
	const pinId = useId();
	return (
		<li
			className="row-item"
			{...(windowed === undefined
				? {}
				: {
						ref: windowed.measure,
						'data-id': row.id,
						'aria-setsize': windowed.of,
						'aria-posinset': windowed.at,
						// From its menu too, which is a portal: React's events
						// come up through it.
						onFocus: () => {
							windowed.onFocus(row.id);
						},
						onBlur: () => {
							windowed.onFocus(undefined);
						},
					})}
		>
			<button
				type="button"
				className={[
					pinned ? 'pinned' : undefined,
					selected ? 'selected' : undefined,
					moving ? 'moving' : undefined,
				].reduce(
					(className, extra) =>
						extra === undefined ? className : `${className} ${extra}`,
					'row'
				)}
				onClick={() => {
					onSelect(row);
				}}
				onContextMenu={(event) => {
					if (onMenu === undefined) return;
					event.preventDefault();
					onMenu(row, menuPoint(event));
				}}
				aria-current={selected ? 'true' : undefined}
				// Said beside the name rather than in it, as a notebook's is.
				aria-describedby={pinned ? pinId : undefined}
				draggable={onPickUp !== undefined}
				onDragStart={(event) => {
					if (onPickUp === undefined) return;
					// Firefox starts no drag without data on it, and the title is what
					// another application receives if the note is dropped outside.
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('text/plain', titleShown(note.title));
					onPickUp(row);
				}}
				onDragEnd={onCancelMove}
			>
				<span className="note-title">
					{titleShown(note.title)}
					{note.dirty === 1 && (
						<span
							className="dot"
							title={t('notes.list.notSynced')}
							aria-label={t('notes.list.notSynced')}
						/>
					)}
				</span>
				<span className="note-meta">{editedAt(row.updatedAt)}</span>
				<Preview note={note} typing={note.body !== row.body} />
				{pinned && (
					<span id={pinId} hidden>
						{t('rows.pinned')}
					</span>
				)}
			</button>
			<RowOptions
				name={titleShown(note.title)}
				kind="Note"
				items={menuFor === undefined ? [] : () => menuFor(row)}
			/>
		</li>
	);
};

const NoteRow = memo(NoteRowView);

/**
 * Where a notebook inside the open one is, from the open one: `Projects/Q3`
 * under `Work`, as the pane's heading spells a path. As both are being typed
 * when either is being renamed, as the heading is.
 */
const GroupName = ({
	path,
	folderPath,
	renamings,
}: {
	path: string;
	folderPath: string;
	renamings: Renamings | undefined;
}) => {
	const renaming = useRenaming(renamings);
	const shown = shownFolder(path, renaming);
	const from = `${shownFolder(folderPath, renaming)}/`;
	return shown.startsWith(from) ? shown.slice(from.length) : shown;
};

/** The notes of one notebook inside the open one, under its name. */
const NoteGroup = ({
	path,
	folderPath,
	renamings,
	measure,
	children,
}: {
	path: string;
	folderPath: string;
	renamings: Renamings | undefined;
	/** Where the list is windowed, how its name is measured. */
	measure: Measure | undefined;
	children: ReactNode;
}) => {
	const nameId = useId();
	return (
		<section className="note-group" aria-labelledby={nameId}>
			<h3
				id={nameId}
				className="note-group-name"
				ref={measure}
				data-id={measure === undefined ? undefined : path}
			>
				<GroupName path={path} folderPath={folderPath} renamings={renamings} />
			</h3>
			<ul>{children}</ul>
		</section>
	);
};

/**
 * The open notebook's name, as it is being typed when it is being renamed.
 * Its own component, so a keystroke redraws the heading and not the list.
 */
const Heading = ({
	folderPath,
	renamings,
}: {
	folderPath: string | undefined;
	renamings: Renamings | undefined;
}) => {
	const renaming = useRenaming(renamings);
	return folderPath === undefined
		? t('notes.list.title')
		: folderLabel(shownFolder(folderPath, renaming));
};

/** Above this many rows, a list draws only those near the screen (`windowing.ts`, #275). */
export const WINDOWED_ABOVE = 150;

/**
 * A row's height and a notebook's name's before any has been measured, in
 * pixels: a title, a date and a line of the note; a line of small capitals.
 * Once some have been, the others are taken to be as tall as those are.
 */
const ROW_GUESS = 64;
const NAME_GUESS = 30;

const meanOr = (heights: ReadonlyMap<string, number>, guess: number): number =>
	heights.size === 0
		? guess
		: [...heights.values()].reduce((sum, height) => sum + height, 0) / heights.size;

/**
 * One notebook's notes, in a list: the open notebook's own, or one inside it
 * under its name. `start` is where it starts among the list's items, a name
 * being an item before the rows under it.
 */
interface Run {
	readonly path: string;
	readonly notes: readonly NoteRecord[];
	readonly named: boolean;
	readonly start: number;
}

const runsOf = (notes: readonly NoteRecord[], folderPath: string): readonly Run[] => {
	const next = { current: 0 };
	return [...byParent(notes)].map(([path, inIt]) => {
		const named = path !== folderPath;
		const start = next.current;
		next.current += (named ? 1 : 0) + inIt.length;
		return { path, notes: inIt, named, start };
	});
};

/**
 * A run's rows in a windowed list: those near the screen (`near`) or kept
 * drawn, and in place of each stretch of the others an empty item as tall as
 * they are. Nothing where none of the run is to be drawn, its name included.
 */
const windowRows = (
	run: Run,
	tops: readonly number[],
	near: Readonly<{ first: number; end: number }>,
	kept: ReadonlySet<string>,
	row: (note: NoteRecord, place: Readonly<{ at: number; of: number }>) => ReactNode
): ReactNode[] | undefined => {
	const from = run.start + (run.named ? 1 : 0);
	const drawn = run.notes.map(
		(note, at) => (from + at >= near.first && from + at < near.end) || kept.has(note.id)
	);
	const nameNear = run.named && run.start >= near.first && run.start < near.end;
	if (!nameNear && !drawn.includes(true)) return undefined;
	const skipped = (start: number, end: number, after: string) => (
		<li
			key={`skipped-${after}`}
			className="rows-skipped"
			aria-hidden="true"
			style={{ height: (tops[from + end] ?? 0) - (tops[from + start] ?? 0) }}
		/>
	);
	const gap = { start: 0 };
	const rows = run.notes.flatMap((note, at) => {
		if (!drawn[at]) return [];
		const before = gap.start < at ? [skipped(gap.start, at, note.id)] : [];
		gap.start = at + 1;
		return [...before, row(note, { at: at + 1, of: run.notes.length })];
	});
	return gap.start < run.notes.length
		? [...rows, skipped(gap.start, run.notes.length, 'end')]
		: rows;
};

export const NoteList = ({
	notes,
	selectedNoteId,
	onSelectNote,
	onCreateNote,
	onCreateNotebook,
	folderPath,
	storeLoaded,
	onPickUpNote,
	onCancelMove,
	movingNoteId,
	unsavedNoteId,
	liveEdits,
	menuFor,
	renamings,
	pinnedNoteIds,
}: NoteListProps) => {
	/** A row right-clicked, and where: the note's menu is open there. */
	const [menu, setMenu] = useState<{ note: NoteRecord; at: MenuPoint } | null>(null);
	const windowed = notes !== undefined && notes.length > WINDOWED_ABOVE;
	/** The row the focus is in, or in its menu: drawn wherever it is scrolled to. */
	const [focusedId, setFocusedId] = useState<string>();
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const [content, setContent] = useState<HTMLDivElement | null>(null);
	// Not listened for at all where every row is drawn.
	const span = useScrollSpan(windowed ? scroller : null, windowed ? content : null);
	const rowHeights = useHeights();
	const nameHeights = useHeights();
	const runs = useMemo(
		() => (notes === undefined || folderPath === undefined ? [] : runsOf(notes, folderPath)),
		[notes, folderPath]
	);
	// Each item's top, where the list is windowed: as measured, where it has been.
	const tops = useMemo(() => {
		if (!windowed) return undefined;
		const row = meanOr(rowHeights.heights, ROW_GUESS);
		const name = meanOr(nameHeights.heights, NAME_GUESS);
		return topsOf(
			runs.flatMap((run) => [
				...(run.named ? [nameHeights.heights.get(run.path) ?? name] : []),
				...run.notes.map((note) => rowHeights.heights.get(note.id) ?? row),
			])
		);
	}, [windowed, runs, rowHeights.heights, nameHeights.heights]);
	const near = tops === undefined || span === undefined ? undefined : indicesIn(tops, span);
	// The rows the user is at, drawn wherever they are.
	const kept = new Set(
		[selectedNoteId, movingNoteId, focusedId, menu?.note.id].filter((id) => id !== undefined)
	);
	// The handlers this list is given are made again on each draw of the page.
	// The rows are handed these instead, which stay the same and call the ones
	// given last, so that a row is drawn again only when what it shows changes.
	// Set before the browser paints, so an event never reaches the ones before.
	const given = useRef({ onSelectNote, onPickUpNote, onCancelMove, menuFor });
	useLayoutEffect(() => {
		given.current = { onSelectNote, onPickUpNote, onCancelMove, menuFor };
	});
	const select = useCallback((note: NoteRecord) => {
		given.current.onSelectNote(note);
	}, []);
	const pickUp = useCallback((note: NoteRecord) => {
		given.current.onPickUpNote?.(note);
	}, []);
	const cancelMove = useCallback(() => {
		given.current.onCancelMove?.();
	}, []);
	const itemsFor = useCallback((note: NoteRecord) => given.current.menuFor?.(note) ?? [], []);
	const openMenu = useCallback((note: NoteRecord, at: MenuPoint) => {
		setMenu({ note, at });
	}, []);
	// Each row asks for its opening when it is drawn.
	keepRows('notes', notes?.length ?? 0);
	const placeholder = placeholderFor({
		notes,
		folderPath,
		storeLoaded,
		onCreateNote,
		onCreateNotebook,
	});
	const row = (note: NoteRecord, place?: Readonly<{ at: number; of: number }>) => {
		const stored = note.id !== unsavedNoteId;
		return (
			<NoteRow
				key={note.id}
				windowed={
					place === undefined
						? undefined
						: { ...place, measure: rowHeights.measure, onFocus: setFocusedId }
				}
				note={note}
				selected={note.id === selectedNoteId}
				onSelect={select}
				liveEdits={liveEdits}
				onPickUp={onPickUpNote === undefined || !stored ? undefined : pickUp}
				onCancelMove={cancelMove}
				moving={note.id === movingNoteId}
				pinned={pinnedNoteIds?.has(note.id) === true}
				{...(menuFor === undefined || !stored
					? {}
					: { menuFor: itemsFor, onMenu: openMenu })}
			/>
		);
	};

	return (
		<section ref={setScroller} className="note-list" aria-label={t('notes.list.title')}>
			<div className="pane-header">
				<h2>
					<Heading folderPath={folderPath} renamings={renamings} />
				</h2>
				<div className="pane-actions">
					<button
						type="button"
						className="icon"
						title={t('notes.list.newNote')}
						aria-label={t('notes.list.newNote')}
						// Every note the app creates lives in a notebook, so there is
						// nowhere to put one until a notebook is open. The root is not
						// a notebook: loose notes are imported, never created here.
						disabled={folderPath === undefined || folderPath === ROOT}
						onClick={onCreateNote}
					>
						+
					</button>
				</div>
			</div>

			{placeholder !== undefined && <p className="muted placeholder">{placeholder}</p>}

			{notes !== undefined && folderPath !== undefined && (
				<div ref={setContent} className="note-rows">
					{runs.map((run) => {
						const rows =
							tops === undefined || near === undefined
								? run.notes.map((note) => row(note))
								: windowRows(run, tops, near, kept, row);
						if (rows === undefined && tops !== undefined) {
							const end = run.start + (run.named ? 1 : 0) + run.notes.length;
							return (
								<div
									key={run.path}
									className="rows-skipped"
									aria-hidden="true"
									style={{ height: (tops[end] ?? 0) - (tops[run.start] ?? 0) }}
								/>
							);
						}
						return run.named ? (
							<NoteGroup
								key={run.path}
								path={run.path}
								folderPath={folderPath}
								renamings={renamings}
								measure={windowed ? nameHeights.measure : undefined}
							>
								{rows}
							</NoteGroup>
						) : (
							<ul key={run.path}>{rows}</ul>
						);
					})}
				</div>
			)}

			{menu !== null && menuFor !== undefined && (
				<FloatingMenu
					at={menu.at}
					label={t('rows.note.menu', { name: titleShown(menu.note.title) })}
					items={menuFor(menu.note)}
					onClose={() => {
						setMenu(null);
					}}
				/>
			)}
		</section>
	);
};
