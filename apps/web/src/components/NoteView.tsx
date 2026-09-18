import { frontmatterIsEditable } from '@skysa/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { parseChord } from '../commands/chord.js';
import { useCommand } from '../commands/context.js';
import { FindTargetProvider } from '../editor/findTarget.js';
import { type EditorMode, MODE_LABELS, otherMode } from '../editor/mode.js';
import { RawEditor } from '../editor/RawEditor.js';
import { RichEditor } from '../editor/RichEditor.js';
import { useAutosave } from '../editor/useAutosave.js';
import { db, type NoteRecord } from '../store/db.js';
import { useDefaultEditorMode } from '../store/hooks.js';
import { deleteNote, renameNote, saveNoteBody, setNoteEditorMode } from '../store/notes.js';
import { FindBar } from './FindBar.js';
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
	onDeleted: () => void;
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

	const commit = () => {
		const trimmed = draft?.trim();
		const abandoned = cancelled.current;
		cancelled.current = false;
		setDraft(null);
		if (abandoned) return;
		if (trimmed === undefined || trimmed === '' || trimmed === note.title) return;
		void renameNote(db, note.id, trimmed);
	};

	return (
		<input
			className="note-title-input"
			aria-label="Note title"
			value={draft ?? note.title}
			onChange={(event) => {
				setDraft(event.target.value);
			}}
			onBlur={commit}
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
	onUserEdit,
	onUnsupported,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	showOutline: boolean;
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: () => void;
}) => {
	const body = useRef<HTMLDivElement>(null);
	return (
		<div className="note-body" ref={body}>
			{mode === 'raw' && (
				<RawEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
				/>
			)}
			{mode === 'rich' && (
				<RichEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onUnsupported={onUnsupported}
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

export const NoteView = ({ note, onDeleted }: NoteViewProps) => {
	const noteId = note?.id;
	const defaultMode = useDefaultEditorMode();

	/**
	 * The note the rich editor reported it could not represent. Held by id rather
	 * than as a boolean so moving to another note clears it without an effect.
	 */
	const [unsupportedId, setUnsupportedId] = useState<string | null>(null);
	const unsupported = noteId !== undefined && unsupportedId === noteId;

	// The note as last shown. An edit carries it: a copy of the edit is written
	// from it, and a note a sync deleted is brought back as it.
	const shown = useRef(note);
	useEffect(() => {
		shown.current = note;
	}, [note]);

	const save = useCallback(
		({ body, origin, note: typedInto }: Edit) => {
			if (noteId === undefined) return;
			void saveNoteBody(
				db,
				noteId,
				body,
				typedInto?.id === noteId ? { origin, note: typedInto } : undefined
			);
		},
		[noteId]
	);

	const autosave = useAutosave<Edit>({
		key: noteId ?? 'none',
		save,
		// An edit typed into a body a sync has since replaced is saved on its own,
		// before the next one — made from the new body — can stand for it.
		supersedes: sameBase,
	});
	const { change, flush } = autosave;
	const onUserEdit = useCallback(
		(body: string, origin: string) => {
			change({ body, origin, note: shown.current });
		},
		[change]
	);

	const mode: EditorMode | undefined = unsupported ? 'raw' : (note?.editorMode ?? defaultMode);

	const toggleMode = useCallback(() => {
		if (noteId === undefined || mode === undefined || unsupported) return;
		// Write the pending edit first: the incoming editor loads from the note
		// record, and the mode switch itself must never be what saves — or lose —
		// what the user typed.
		flush();
		void setNoteEditorMode(db, noteId, otherMode(mode));
	}, [flush, mode, noteId, unsupported]);

	// Shown by default, and unmounted rather than hidden when it is not: the
	// headings are re-read when it comes back, which is one parse of one note,
	// and a rail that is not there cannot be tabbed through. It costs nothing
	// when a note has no headings either, since `Outline` renders nothing then.
	const [showOutline, setShowOutline] = useState(true);
	useCommand({
		id: 'note.outline',
		label: showOutline ? 'Hide outline' : 'Show outline',
		group: 'Note',
		enabled: noteId !== undefined,
		run: () => {
			setShowOutline((shown) => !shown);
		},
	});

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
				finding={finding}
				showOutline={showOutline}
				toggleMode={toggleMode}
				onClose={() => {
					setFinding(0);
				}}
				onDelete={() => {
					autosave.flush();
					void deleteNote(db, note.id).then(onDeleted);
				}}
				onUserEdit={onUserEdit}
				onUnsupported={() => {
					setUnsupportedId(note.id);
				}}
			/>
		</FindTargetProvider>
	);
};

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
	finding,
	showOutline,
	toggleMode,
	onClose,
	onDelete,
	onUserEdit,
	onUnsupported,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	unsupported: boolean;
	finding: number;
	showOutline: boolean;
	toggleMode: () => void;
	onClose: () => void;
	onDelete: () => void;
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: () => void;
}) => (
	<section className="note-view" aria-label="Note">
		<header className="note-header">
			<TitleField key={note.id} note={note} />
			<div className="note-actions">
				<span className="muted path" title={note.path}>
					{note.path}
				</span>
				{mode !== undefined && (
					<button
						type="button"
						onClick={toggleMode}
						disabled={unsupported}
						aria-pressed={mode === 'raw'}
						title={
							unsupported
								? 'This note has to stay in markdown mode'
								: `Switch to ${MODE_LABELS[otherMode(mode)].toLowerCase()} (Ctrl/Cmd+E)`
						}
					>
						{MODE_LABELS[mode]}
					</button>
				)}
				<button type="button" onClick={onDelete}>
					Delete
				</button>
			</div>
		</header>

		{unsupported && (
			<p className="banner" role="status">
				This note uses markdown the rich editor has no way to show, so it stays in markdown
				mode. Nothing in it has been changed.
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
				There is a YAML error in this note’s frontmatter, so its title and tags cannot be
				saved back to the file — the text is left exactly as it is rather than guessed at.
				Everything else about the note works as usual.
			</p>
		)}

		{finding > 0 && <FindBar focusToken={finding} onClose={onClose} />}

		<NoteBody
			note={note}
			mode={mode}
			showOutline={showOutline}
			onUserEdit={onUserEdit}
			onUnsupported={onUnsupported}
		/>
	</section>
);
