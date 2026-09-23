import { frontmatterIsEditable, headings } from '@skysa/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseChord } from '../commands/chord.js';
import { useCommand } from '../commands/context.js';
import { FindTargetProvider } from '../editor/findTarget.js';
import { Icon, type IconName } from '../editor/icons.js';
import { type EditorMode, MODE_LABELS, otherMode } from '../editor/mode.js';
import { RawEditor } from '../editor/RawEditor.js';
import { RichEditor, type RichEditorProps } from '../editor/RichEditor.js';
import { type SaveContext, useAutosave } from '../editor/useAutosave.js';
import { db, type NoteRecord, noteRef } from '../store/db.js';
import { beforeClosing } from '../store/heldEdits.js';
import { useDefaultEditorMode } from '../store/hooks.js';
import {
	deleteNote,
	getNote,
	isUnnamed,
	renameNote,
	saveNoteBody,
	setNoteEditorMode,
} from '../store/notes.js';
import { FindBar } from './FindBar.js';
import {
	COMPACT,
	OUTLINE_FITS_AT,
	OUTLINE_OPENS_AT,
	rems,
	useElementWidth,
	useMediaQuery,
} from './layout.js';
import { OptionsMenu } from './OptionsMenu.js';
import { Outline } from './Outline.js';

/** The open note: its title, its body, and the actions that act on it. */

/** `Cmd+E` on a Mac, `Ctrl+E` elsewhere — see `commands/chord.ts`. */
const MODE_TOGGLE = parseChord('Mod+E');

/**
 * `Mod+F`. `Mod+Shift+F` is already searching every note, which is a different
 * question — this one is about the note that is open.
 *
 * On a Mac that means Cmd+F. Ctrl+F there reaches the raw editor first, where
 * CodeMirror's `standardKeymap` binds the emacs `Ctrl-f` to move the cursor one
 * character right and calls `preventDefault`, and `useShortcuts` stands aside
 * for a keystroke somebody nearer has already acted on. The same is true of
 * Ctrl+E and Ctrl+K, which `commands/context.ts` describes; Cmd is the modifier
 * a Mac user reaches for anyway.
 */
const FIND = parseChord('Mod+F');

export interface NoteViewProps {
	note: NoteRecord | undefined;
	/**
	 * With the note as it was deleted, holding the text the editor held — which
	 * is not always what the row holds: a save the store refused never got there.
	 * It is what an undo puts back.
	 */
	/**
	 * The note as it was deleted, holding the last text the store never took.
	 * `beside` is such text where it is *not* the newest — an edit whose save
	 * failed, with a later one stored since that was not typed over it. An undo
	 * keeps it beside the note; as the body it would undo that later edit.
	 */
	onDeleted: (deleted: NoteRecord, beside?: DisplacedText) => void;
	/**
	 * Pick the note up to put it down in another notebook, as dragging its row
	 * does. Offered in the note's menu only when given: nothing can be moved
	 * while something else already is.
	 */
	onMove?: () => void;
}

/**
 * `draft` is null except while the user is actually typing in the field, so a
 * title that changes underneath — a rename from sync, or a heading edit in the
 * body — shows through without any state to keep in step.
 */
const TitleField = ({ note }: { note: NoteRecord }) => {
	const [draft, setDraft] = useState<string | null>(null);
	// Escape has to reach `commit` through something `commit` can read
	// synchronously. `blur()` dispatches the blur event before React has
	// re-rendered, so `commit` runs against the render in which `draft` is still
	// the typed value: clearing state and blurring means Escape renames the note
	// — and the file on disk — to whatever the user was trying to throw away.
	const cancelled = useRef(false);
	/**
	 * Whether the press that is focusing the field should leave the whole name
	 * selected. "Untitled" is a placeholder, not a name, and the reason to
	 * click it is to replace it: selecting it on the way in means typing does
	 * that, where a caret dropped in the middle of it means deleting it first.
	 * The browser puts a caret where the pointer was released, after focus, so
	 * the selection made on focus has to survive the release — hence the flag
	 * read on `mouseup`. A named note is left alone: a click in a real name is
	 * a click at a place in it.
	 */
	const keepSelection = useRef(false);

	const commit = () => {
		const trimmed = draft?.trim();
		const abandoned = cancelled.current;
		cancelled.current = false;
		setDraft(null);
		if (abandoned) return;
		if (trimmed === undefined || trimmed === '' || trimmed === note.title) return;
		void renameNote(db, note.id, trimmed, { connectionId: note.connectionId });
	};

	return (
		<input
			className="note-title-input"
			aria-label="Note title"
			value={draft ?? note.title}
			onChange={(event) => {
				setDraft(event.target.value);
			}}
			onFocus={(event) => {
				if (draft !== null || !isUnnamed(note)) return;
				event.currentTarget.select();
				keepSelection.current = true;
			}}
			onMouseUp={(event) => {
				if (!keepSelection.current) return;
				keepSelection.current = false;
				event.preventDefault();
			}}
			onBlur={() => {
				keepSelection.current = false;
				commit();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') event.currentTarget.blur();
				if (event.key === 'Escape') {
					cancelled.current = true;
					event.currentTarget.blur();
				}
			}}
		/>
	);
};

/** Text typed into a note that belongs beside it: see `NoteViewProps.onDeleted`. */
export interface DisplacedText {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
}

interface Edit {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
	/** The note as it was shown when this was typed. */
	note: NoteRecord | undefined;
}

const sameBase = (next: Edit, pending: Edit): boolean => next.origin === pending.origin;

/**
 * Whichever editor is open, with the outline beside it.
 *
 * Its own component so that `NoteView` stays inside the complexity limit, and
 * because the rail needs an element to look inside: `body` is the one both the
 * editor and the outline are under, and only this part of the tree cares.
 */
const NoteBody = ({
	note,
	mode,
	showOutline,
	toolbar,
	onUserEdit,
	onUnsupported,
	onAdopted,
	onBody,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	showOutline: boolean;
	toolbar: RichEditorProps['toolbar'];
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: () => void;
	onAdopted: () => void;
	/** The element, for whoever sizes the outline by its width. */
	onBody: (element: HTMLDivElement | null) => void;
}) => {
	const body = useRef<HTMLDivElement>(null);
	const attach = useCallback(
		(element: HTMLDivElement | null) => {
			body.current = element;
			onBody(element);
		},
		[onBody]
	);
	return (
		<div className="note-body" ref={attach}>
			{mode === 'raw' && (
				<RawEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onAdopted={onAdopted}
				/>
			)}
			{mode === 'rich' && (
				<RichEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onUnsupported={onUnsupported}
					onAdopted={onAdopted}
					toolbar={toolbar}
				/>
			)}
			{showOutline && (
				<Outline
					body={note.body}
					// Read when a row is clicked, not when it is drawn: the
					// editor is a sibling that mounts and unmounts with the mode,
					// so a reference taken at render time is stale the moment the
					// mode changes.
					editor={() => body.current?.querySelector('.editor') ?? null}
				/>
			)}
		</div>
	);
};

/**
 * What of the note's furniture there is room for: the outline beside it, and
 * where the formatting toolbar goes.
 *
 * **The outline** is sized by the note's own width, not the window's — the
 * same window gives the note very different room with the columns beside it
 * and without them. At 53.5rem and wider it starts open (`OUTLINE_OPENS_AT`),
 * below that it starts collapsed and is a press away, and below 36rem it is
 * not offered at all (`OUTLINE_FITS_AT`), since the rail would leave the note
 * narrower than itself. Once pressed it stays as the user left it for as long
 * as the app is open, whatever the room does. Unmounted rather than hidden
 * when it is not shown: the headings are re-read when it comes back, which is
 * one parse of one note, and a rail that is not there cannot be tabbed
 * through.
 *
 * **The toolbar** is across the top in a wide window, as it always was. In a
 * compact one it is hidden until asked for and then sits at the bottom of the
 * editor, under the thumb: the screen is too short to spend a row of buttons
 * above every note, and the inline toolbar and the slash menu are still there
 * without it.
 */
const useNoteLayout = (noteId: string | undefined, body: Element | null) => {
	const compact = useMediaQuery(COMPACT);
	const width = useElementWidth(body);
	const outlineFits = width === undefined || width >= rems(OUTLINE_FITS_AT);
	const outlineOpens = width === undefined || width >= rems(OUTLINE_OPENS_AT);

	const [outlineChoice, setOutlineChoice] = useState<boolean | null>(null);
	const showOutline = outlineFits && (outlineChoice ?? outlineOpens);
	const toggleOutline = useCallback(() => {
		setOutlineChoice(!showOutline);
	}, [showOutline]);
	useCommand({
		id: 'note.outline',
		label: showOutline ? 'Hide outline' : 'Show outline',
		group: 'Note',
		enabled: noteId !== undefined && outlineFits,
		run: toggleOutline,
	});

	const [toolbarShown, setToolbarShown] = useState(false);
	const bottom = toolbarShown ? 'bottom' : 'none';
	const toolbar: RichEditorProps['toolbar'] = compact ? bottom : 'top';
	const toggleToolbar = useCallback(() => {
		setToolbarShown((shown) => !shown);
	}, []);

	return { compact, outlineFits, showOutline, toggleOutline, toolbar, toggleToolbar };
};

export const NoteView = ({ note, onDeleted, onMove }: NoteViewProps) => {
	const noteId = note?.id;
	const defaultMode = useDefaultEditorMode();

	/**
	 * The note the rich editor reported it could not represent. Held by id rather
	 * than as a boolean so moving to another note clears it without an effect.
	 */
	const [unsupportedId, setUnsupportedId] = useState<string | null>(null);
	// By source as well as id, like everything else held here across renders:
	// another source's note of the same id is another note.
	const ref = note === undefined ? undefined : noteRef(note);
	const unsupported = ref !== undefined && unsupportedId === ref;

	// The note as last shown. An edit carries it: a copy of the edit is written
	// from it, and a note a sync deleted is brought back as it.
	const shown = useRef(note);
	useEffect(() => {
		shown.current = note;
	}, [note]);

	const save = useCallback(
		({ body, origin, note: typedInto }: Edit, context?: SaveContext) => {
			if (noteId === undefined) return undefined;
			const base =
				typedInto !== undefined && noteRef(typedInto) === ref
					? { origin, note: typedInto }
					: undefined;
			// Returned, not dropped: autosave holds the edit until this settles,
			// and a rejection nobody hears is a user typing into nothing.
			return saveNoteBody(
				db,
				noteId,
				body,
				// Displaced with nothing to write a copy from cannot happen — every
				// edit carries the note — and would be written as the body if it did.
				base !== undefined && context?.displaced === true
					? { ...base, displaced: true }
					: base
			);
		},
		[noteId, ref]
	);

	const autosave = useAutosave<Edit>({
		key: ref ?? 'none',
		save,
		// An edit typed into a body a sync has since replaced is saved on its own,
		// before the next one — made from the new body — can stand for it.
		supersedes: sameBase,
	});
	const { change, flush, settle, rebased, overtaken, forget } = autosave;
	// A newer build in another tab closes this one's database; what is held
	// here goes in first.
	useEffect(() => beforeClosing(settle), [settle]);
	const onUserEdit = useCallback(
		(body: string, origin: string) => {
			change({ body, origin, note: shown.current });
		},
		[change]
	);

	const onDelete = useCallback(() => {
		if (note === undefined) return;
		// Written first, so the last words are in the row before it is a
		// tombstone: restoring it brings them back with it.
		flush();
		// By the note's own source throughout: an id names a note only there, and
		// the one showing may have changed by the time a continuation runs.
		const home = { connectionId: note.connectionId };
		void deleteNote(db, note.id, home)
			// Everything out has come back, and what had failed has had one more
			// try — into the tombstone, which keeps an edit and stays deleted.
			.then(settle)
			// Deleted either way; a row that cannot be read is the note as shown.
			.then(() => getNote(db, note.id, home).catch(() => undefined))
			.then((row) => {
				// Only now that it is deleted, and nothing before: a held edit
				// retried after sync has purged the row would bring the note back
				// (`saveNoteBody`), here and on the provider. What is let go is
				// what the store never took, and undo cannot bring back less than
				// the user had written — so it goes along. Asked of autosave, by
				// note, rather than remembered here: a save that went into a
				// conflict copy is stored, and offered again it would be copied
				// again.
				const unstored = forget(noteRef(note));
				const deleted = row ?? note;
				if (unstored === undefined) {
					onDeleted(deleted);
					return;
				}
				if (unstored.displaced) {
					onDeleted(deleted, unstored.value);
					return;
				}
				const { body, origin } = unstored.value;
				onDeleted({ ...deleted, body, bodyOrigin: origin });
			});
	}, [flush, forget, note, onDeleted, settle]);

	const mode: EditorMode | undefined = unsupported ? 'raw' : (note?.editorMode ?? defaultMode);

	const toggleMode = useCallback(() => {
		if (noteId === undefined || mode === undefined || unsupported) return;
		// Write the pending edit first: the incoming editor loads from the note
		// record, and the mode switch itself must never be what saves — or lose —
		// what the user typed. `rebased` flushes, and says the editor that comes
		// next starts from the stored body rather than from what this one held.
		rebased();
		void setNoteEditorMode(db, noteId, otherMode(mode), { connectionId: note?.connectionId });
	}, [rebased, mode, noteId, note?.connectionId, unsupported]);

	// The element the outline shares the room of, as state rather than a ref:
	// a note opening mounts it, and the width has to be asked of the new one.
	const [body, setBody] = useState<HTMLDivElement | null>(null);
	const layout = useNoteLayout(noteId, body);

	// A count of askings rather than a boolean: asking again with the bar already
	// open re-focuses and selects its field, which is what `Mod+F` does
	// everywhere else, and the bar needs to be able to tell one asking from the
	// next to do it.
	const [finding, setFinding] = useState(0);
	useCommand({
		id: 'note.find',
		label: 'Find in note',
		group: 'Note',
		chord: FIND,
		enabled: noteId !== undefined,
		run: () => {
			setFinding((times) => times + 1);
		},
	});

	// Registered rather than listened for. The chord the app watches and the
	// chord the palette prints are then the same one by construction, and a
	// second window listener cannot race this one for the same keystroke.
	useCommand({
		id: 'note.toggleMode',
		label: `Edit as ${MODE_LABELS[otherMode(mode ?? 'rich')].toLowerCase()}`,
		group: 'Note',
		chord: MODE_TOGGLE,
		enabled: noteId !== undefined && mode !== undefined && !unsupported,
		run: toggleMode,
	});

	if (note === undefined) {
		return (
			<section className="note-view empty" aria-label="Note">
				<p className="muted placeholder">Select a note, or create one.</p>
			</section>
		);
	}

	return (
		<FindTargetProvider>
			<NoteScreen
				note={note}
				mode={mode}
				unsupported={unsupported}
				unsaved={autosave.failing}
				finding={finding}
				layout={layout}
				onBody={setBody}
				toggleMode={toggleMode}
				onClose={() => {
					setFinding(0);
				}}
				onDelete={onDelete}
				onMove={onMove}
				onUserEdit={onUserEdit}
				onUnsupported={() => {
					// The raw editor takes over, built from the stored body.
					rebased();
					setUnsupportedId(noteRef(note));
				}}
				// A body from outside is on screen now. What was typed before it
				// is not under whatever is typed next — a new sitting, so the next
				// edit cannot stand for a held one — and what is still pending was
				// not typed over it: saved as the body, it would put text the
				// editor no longer shows over the text it does.
				onAdopted={overtaken}
			/>
		</FindTargetProvider>
	);
};

const MODE_ICONS: Record<EditorMode, IconName> = { rich: 'rich-text', raw: 'markdown' };

const tabTitle = (tab: EditorMode, current: boolean, unsupported: boolean): string => {
	const name = MODE_LABELS[tab].toLowerCase();
	if (current) return `Editing as ${name}`;
	if (unsupported) return 'This note has to stay in markdown mode';
	return `Switch to ${name} (Ctrl/Cmd+E)`;
};

/**
 * The two editors as a pair of tabs, the one in use pressed. Two buttons
 * rather than one that names the mode it is in: a single toggle labelled with
 * where you are reads as where it will take you, and an icon cannot carry the
 * difference at all.
 *
 * Pressing the tab already in use does nothing. A note the rich editor cannot
 * represent keeps its markdown tab, pressed, and the rich one is disabled.
 */
const ModeTabs = ({
	mode,
	unsupported,
	toggleMode,
}: {
	mode: EditorMode;
	unsupported: boolean;
	toggleMode: () => void;
}) => (
	<div className="mode-tabs" role="group" aria-label="Editor">
		{(['rich', 'raw'] as const).map((tab) => {
			const current = tab === mode;
			return (
				<button
					key={tab}
					type="button"
					aria-label={MODE_LABELS[tab]}
					aria-pressed={current}
					disabled={!current && unsupported}
					title={tabTitle(tab, current, unsupported)}
					onClick={() => {
						if (!current) toggleMode();
					}}
				>
					<Icon name={MODE_ICONS[tab]} />
				</button>
			);
		})}
	</div>
);

/**
 * Everything below the provider.
 *
 * Split out because the bar and the editors have to be inside the same
 * `FindTargetProvider` — the editor offers itself to it and the bar reads it —
 * and because `NoteView` is at the complexity limit without it.
 */
const NoteScreen = ({
	note,
	mode,
	unsupported,
	unsaved,
	finding,
	layout,
	onBody,
	toggleMode,
	onClose,
	onDelete,
	onMove,
	onUserEdit,
	onUnsupported,
	onAdopted,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	unsupported: boolean;
	/** A save was rejected, and what it held is still only in this tab. */
	unsaved: boolean;
	finding: number;
	layout: ReturnType<typeof useNoteLayout>;
	onBody: (element: HTMLDivElement | null) => void;
	toggleMode: () => void;
	onClose: () => void;
	onDelete: () => void;
	onMove: (() => void) | undefined;
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: () => void;
	onAdopted: () => void;
}) => {
	// Whether there is an outline to open. A button for a rail that would be
	// empty is a button that does nothing when pressed.
	const outlined = useMemo(() => headings(note.body).length > 0, [note.body]);

	return (
		<section className="note-view" aria-label="Note">
			<header className="note-header">
				<TitleField key={noteRef(note)} note={note} />
				<div className="note-actions">
					<span className="muted path" title={note.path}>
						{note.path}
					</span>
					{layout.outlineFits && outlined && (
						<button
							type="button"
							className="note-icon"
							onClick={layout.toggleOutline}
							aria-label="Outline"
							aria-pressed={layout.showOutline}
							title={layout.showOutline ? 'Hide the outline' : 'Show the outline'}
						>
							<Icon name="outline" />
						</button>
					)}
					{layout.compact && mode === 'rich' && (
						<button
							type="button"
							className="note-icon"
							onClick={layout.toggleToolbar}
							aria-label="Format"
							aria-pressed={layout.toolbar === 'bottom'}
							title={
								layout.toolbar === 'bottom'
									? 'Hide the formatting toolbar'
									: 'Show the formatting toolbar'
							}
						>
							<Icon name="format" />
						</button>
					)}
					{mode !== undefined && (
						<ModeTabs mode={mode} unsupported={unsupported} toggleMode={toggleMode} />
					)}
					<OptionsMenu
						label="Note options"
						title="Note options"
						groupLabel={`Note “${note.title}”`}
						triggerClassName="note-icon"
						trigger={<Icon name="more" />}
						items={[
							...(onMove === undefined
								? []
								: [{ label: 'Move to notebook…', onChoose: onMove }]),
							{ label: 'Delete', onChoose: onDelete, danger: true },
						]}
					/>
				</div>
			</header>

			{/*
			 * An alert, and it stays for as long as it is true. It does not say "this
			 * note": a held edit may be to the note that was open before this one.
			 * Nor what went wrong, which the app cannot tell — only what is safe to
			 * do about it.
			 */}
			{unsaved && (
				<p className="banner banner-alert" role="alert">
					Changes are not being saved on this device. Copy your text somewhere safe, then
					reload.
				</p>
			)}

			{unsupported && (
				<p className="banner" role="status">
					This note uses markdown the rich editor has no way to show, so it stays in
					markdown mode. Nothing in it has been changed.
				</p>
			)}

			{/*
			 * A rename or a tag edit cannot reach a file whose frontmatter has a
			 * YAML error in it: the app will not rewrite a block it had to guess
			 * at, so the change lands in the app and not in the file, and the next
			 * sync reads the old values back over it. Saying so is the difference
			 * between a limitation and a note that quietly refuses to be renamed.
			 */}
			{/*
			 * `role="note"`, not `status`: this is true of the note from the moment
			 * it opens, so it is a standing remark rather than something that has
			 * just happened — and two live regions announcing at once is one too
			 * many when a note is also in the rich editor's unsupported state.
			 */}
			{!frontmatterIsEditable(note.frontmatter) && (
				<p className="banner" role="note">
					There is a YAML error in this note’s frontmatter, so its title and tags cannot
					be saved back to the file — the text is left exactly as it is rather than
					guessed at. Everything else about the note works as usual.
				</p>
			)}

			{finding > 0 && <FindBar focusToken={finding} onClose={onClose} />}

			<NoteBody
				note={note}
				mode={mode}
				showOutline={layout.showOutline}
				toolbar={layout.toolbar}
				onUserEdit={onUserEdit}
				onUnsupported={onUnsupported}
				onAdopted={onAdopted}
				onBody={onBody}
			/>
		</section>
	);
};
