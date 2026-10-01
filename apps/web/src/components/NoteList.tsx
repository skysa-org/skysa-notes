import { ROOT } from '@skysa/core';
import { type ReactNode, useDeferredValue, useState } from 'react';

import { type NoteRecord } from '../store/db.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { folderLabel } from '../store/tree.js';
import { openingLines } from '../store/visibleText.js';
import { editedAt } from './editedAt.js';
import { FloatingMenu, type MenuPoint, menuPoint, type OptionsMenuItem } from './OptionsMenu.js';

/**
 * The middle pane: the notes in the selected notebook, newest first by when
 * each was made (`listNotes`). Each row still says when its note was last
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
	notes: NoteRecord[] | undefined;
	selectedNoteId: string | undefined;
	onSelectNote: (id: string) => void;
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
	 * What a right-click on a note's row offers: the note's own menu
	 * (`noteMenuItems`), about that note. Without it the browser's menu opens.
	 */
	menuFor?: (note: NoteRecord) => readonly OptionsMenuItem[];
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
		if (!storeLoaded) return 'Loading…';
		if (onCreateNotebook === undefined) return 'Create a notebook to start writing.';
		return (
			<>
				<button type="button" className="link-button" onClick={onCreateNotebook}>
					Create a notebook
				</button>{' '}
				to start writing.
			</>
		);
	}
	if (notes === undefined) return 'Loading…';
	if (notes.length > 0) return undefined;
	if (folderPath === ROOT) return 'No notes here yet.';
	return (
		<>
			No notes here yet.{' '}
			<button type="button" className="link-button" onClick={onCreateNote}>
				Create one
			</button>
			.
		</>
	);
};

/**
 * Whether a line is the note's title written out again.
 *
 * The line is parsed text, and a title derived from a heading is too, so the
 * two usually agree as they stand. Emphasis characters are still ignored on
 * both sides, for a title that was *written* rather than derived — `title:` in
 * frontmatter, spelled `**Alpha**` above a `# Alpha` — and on both sides
 * because the parse removes only the characters that were emphasis: a title of
 * `setup_guide` keeps its underscore, and stripping one side alone would leave
 * "setupguide" against "setup_guide" and print the heading twice.
 */
const bare = (text: string): string => text.replaceAll(/[*_`]/g, '').trim();

const isTitle = (line: string | undefined, title: string): boolean =>
	line !== undefined && bare(line) === bare(title);

/**
 * What stands between two lines of a note in its row. The row is one line of
 * text, and a space there made two lines read as one sentence: "Buy milk" over
 * "Call the bank" came out as "Buy milk Call the bank". A line is whatever the
 * note shows as one — a paragraph, a heading, a list item, a line broken inside
 * a paragraph (`previewLines`).
 */
const LINE_BREAK = ' | ';

/**
 * The note's opening, after its title, its lines kept apart (`LINE_BREAK`).
 * `previewLines` decides what a readable line is — the visible text, as the rich editor shows it, and the same rule
 * the search excerpt is cut by — and the title is dropped from the front of
 * them so the row does not say it twice.
 *
 * Dropped by *identity*, not by position. Taking the first line on the
 * assumption that it is the heading was wrong in both directions: a note
 * beginning with the `<br />` the editor writes for an empty paragraph has no
 * heading on line one, and lost a line of the user's own writing instead — and
 * a note whose heading comes after an introduction had the introduction eaten
 * and the heading shown. Comparing against the title the row is already
 * displaying is the question actually being asked.
 */
const preview = (body: string, title: string, keep: boolean): string => {
	const lines = openingLines(body, { keep });
	const opening = isTitle(lines[0], title) ? lines.slice(1) : lines;
	const text = opening.join(LINE_BREAK);
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

/**
 * The opening of a note, or nothing at all when it has none to show. `typing`
 * for a body being typed, which is read once and not kept (`visibleLines`).
 */
const Preview = ({ note, typing }: { note: NoteRecord; typing: boolean }) => {
	const text = preview(note.body, note.title, !typing);
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
}: NoteRowProps) => {
	// Deferred, so a keystroke is never kept waiting on a row's redraw: the
	// preview is a parse.
	const note = shownNote(row, useDeferredValue(useLiveEdit(liveEdits, row)));
	return (
		<li>
			<button
				type="button"
				className={[
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
				draggable={onPickUp !== undefined}
				onDragStart={(event) => {
					if (onPickUp === undefined) return;
					// Firefox starts no drag without data on it, and the title is what
					// another application receives if the note is dropped outside.
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('text/plain', note.title);
					onPickUp();
				}}
				onDragEnd={onCancelMove}
			>
				<span className="note-title">
					{note.title}
					{note.dirty === 1 && (
						<span className="dot" title="Not yet synced" aria-label="Not yet synced" />
					)}
				</span>
				<span className="note-meta">{meta}</span>
				<Preview note={note} typing={note.body !== row.body} />
			</button>
		</li>
	);
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
}: NoteListProps) => {
	/** A row right-clicked, and where: the note's menu is open there. */
	const [menu, setMenu] = useState<{ note: NoteRecord; at: MenuPoint } | null>(null);
	const placeholder = placeholderFor({
		notes,
		folderPath,
		storeLoaded,
		onCreateNote,
		onCreateNotebook,
	});
	const heading = folderPath === undefined ? 'Notes' : folderLabel(folderPath);

	return (
		<section className="note-list" aria-label="Notes">
			<div className="pane-header">
				<h2>{heading}</h2>
				<button
					type="button"
					className="icon"
					title="New note"
					aria-label="New note"
					// Every note the app creates lives in a notebook, so there is
					// nowhere to put one until a notebook is open. The root is not
					// a notebook: loose notes are imported, never created here.
					disabled={folderPath === undefined || folderPath === ROOT}
					onClick={onCreateNote}
				>
					+
				</button>
			</div>

			{placeholder !== undefined && <p className="muted placeholder">{placeholder}</p>}

			{notes !== undefined && notes.length > 0 && (
				<ul>
					{notes.map((note) => {
						const stored = note.id !== unsavedNoteId;
						return (
							<NoteRow
								key={note.id}
								note={note}
								selected={note.id === selectedNoteId}
								onSelect={() => {
									onSelectNote(note.id);
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
								{...(menuFor === undefined || !stored
									? {}
									: {
											onMenu: (at: MenuPoint) => {
												setMenu({ note, at });
											},
										})}
							/>
						);
					})}
				</ul>
			)}

			{menu !== null && menuFor !== undefined && (
				<FloatingMenu
					at={menu.at}
					label={`Note “${menu.note.title}”`}
					items={menuFor(menu.note)}
					onClose={() => {
						setMenu(null);
					}}
				/>
			)}
		</section>
	);
};
