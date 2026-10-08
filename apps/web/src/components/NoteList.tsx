import { parentPath, ROOT } from '@skysa/core';
import { type ReactNode, useDeferredValue, useId, useState } from 'react';

import { rich } from '../i18n/rich.js';
import { t } from '../i18n/t.js';
import { type NoteRecord } from '../store/db.js';
import { keepRows } from '../store/kept.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { type Renamings, shownFolder, useRenaming } from '../store/renaming.js';
import { titleShown } from '../store/titles.js';
import { folderLabel } from '../store/tree.js';
import { noteOpening, openingLines } from '../store/visibleText.js';
import { editedAt } from './editedAt.js';
import { FloatingMenu, type MenuPoint, menuPoint, type OptionsMenuItem } from './OptionsMenu.js';
import { RowOptions } from './RowOptions.js';

/**
 * The middle pane: the notes in the selected notebook, newest first by when
 * each was made (`listNotes`), with any pinned on this device above the rest
 * (`store/pins.ts`); then the notes in the notebooks inside it, at any depth,
 * each notebook's under its name (`listedUnder`). Each row still says when its note was last
 * edited; that is what it says, not where it sits. A row says what is being
 * typed into its note as it is typed, not once autosave has stored it
 * (`store/liveEdits.ts`), so the list and the editor beside it never disagree.
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

interface NoteRowProps {
	note: NoteRecord;
	selected: boolean;
	onSelect: () => void;
	/** The line under the title: when it was edited. */
	meta: string;
	liveEdits: LiveEdits | undefined;
	/** Missing where the pane was rendered without anywhere to drag a note to. */
	onPickUp?: () => void;
	onCancelMove?: () => void;
	/** True while this is the row being moved. */
	moving: boolean;
	/** A right-click, where the note has a menu. */
	onMenu?: (at: MenuPoint) => void;
	/** What its `⋯` and its right-click offer: none for a note not stored yet. */
	items: readonly OptionsMenuItem[];
	/** Pinned to the top of the list on this device. */
	pinned: boolean;
}

const NoteRow = ({
	note: row,
	selected,
	onSelect,
	meta,
	liveEdits,
	onPickUp,
	onCancelMove,
	moving,
	onMenu,
	items,
	pinned,
}: NoteRowProps) => {
	// Deferred, so a keystroke is never kept waiting on a row's redraw: the
	// preview is a parse.
	const note = shownNote(row, useDeferredValue(useLiveEdit(liveEdits, row)));
	const pinId = useId();
	return (
		<li className="row-item">
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
				onClick={onSelect}
				onContextMenu={(event) => {
					if (onMenu === undefined) return;
					event.preventDefault();
					onMenu(menuPoint(event));
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
					onPickUp();
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
				<span className="note-meta">{meta}</span>
				<Preview note={note} typing={note.body !== row.body} />
				{pinned && (
					<span id={pinId} hidden>
						{t('rows.pinned')}
					</span>
				)}
			</button>
			<RowOptions name={titleShown(note.title)} kind="Note" items={items} />
		</li>
	);
};

/**
 * The notes by the notebook each is in, in the order they come: the list hands
 * them over a notebook's together, its own first (`listedUnder`).
 */
const byNotebook = (notes: readonly NoteRecord[]): [string, NoteRecord[]][] => [
	...notes
		.reduce(
			(groups, note) =>
				groups.set(parentPath(note.path), [
					...(groups.get(parentPath(note.path)) ?? []),
					note,
				]),
			new Map<string, NoteRecord[]>()
		)
		.entries(),
];

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
	children,
}: {
	path: string;
	folderPath: string;
	renamings: Renamings | undefined;
	children: ReactNode;
}) => {
	const nameId = useId();
	return (
		<section className="note-group" aria-labelledby={nameId}>
			<h3 id={nameId} className="note-group-name">
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
	// Each row asks for its opening when it is drawn.
	keepRows('notes', notes?.length ?? 0);
	const placeholder = placeholderFor({
		notes,
		folderPath,
		storeLoaded,
		onCreateNote,
		onCreateNotebook,
	});
	const row = (note: NoteRecord) => {
		const stored = note.id !== unsavedNoteId;
		return (
			<NoteRow
				key={note.id}
				note={note}
				selected={note.id === selectedNoteId}
				onSelect={() => {
					onSelectNote(note);
				}}
				meta={editedAt(note.updatedAt)}
				liveEdits={liveEdits}
				onPickUp={
					onPickUpNote === undefined || !stored
						? undefined
						: () => {
								onPickUpNote(note);
							}
				}
				onCancelMove={onCancelMove}
				moving={note.id === movingNoteId}
				pinned={pinnedNoteIds?.has(note.id) === true}
				items={menuFor === undefined || !stored ? [] : menuFor(note)}
				{...(menuFor === undefined || !stored
					? {}
					: {
							onMenu: (at: MenuPoint) => {
								setMenu({ note, at });
							},
						})}
			/>
		);
	};

	return (
		<section className="note-list" aria-label={t('notes.list.title')}>
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

			{notes !== undefined &&
				folderPath !== undefined &&
				byNotebook(notes).map(([path, inIt]) =>
					path === folderPath ? (
						<ul key={path}>{inIt.map(row)}</ul>
					) : (
						<NoteGroup
							key={path}
							path={path}
							folderPath={folderPath}
							renamings={renamings}
						>
							{inIt.map(row)}
						</NoteGroup>
					)
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
