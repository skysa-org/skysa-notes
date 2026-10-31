import { useCallback, useEffect, useImperativeHandle, useState } from 'react';

import { parseChord } from '../../commands/chord.js';
import { useCommand } from '../../commands/context.js';
import { FindTargetProvider } from '../../editor/features/find/findTarget.js';
import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import type { NoteRecord } from '../../store/db.js';
import { otherMode } from '../../store/editorMode.js';
import { setScratchMarks } from '../../store/notes.js';
import { scratchMarks } from '../../store/scratchpad.js';
import { focusEditor, inAField } from './focus.js';
import { NoteScreen } from './NoteScreen.js';
import { useOpeningNotice } from './opening.js';
import type {
	MarkChange,
	NoteDraft,
	NoteViewProps,
	ScratchEditing,
	ScratchScreen,
} from './types.js';
import { useNoteLayout } from './useNoteLayout.js';
import { useNoteSession } from './useNoteSession.js';

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

/** What the pane says while the note asked for is read, once that is taking a while. */
const Opening = () => {
	const late = useOpeningNotice();
	return (
		<p className="muted placeholder" role="status">
			{late ? t('notes.view.opening') : null}
		</p>
	);
};

/** What the empty pane says, offering what can be done from here. */
const NothingOpen = ({
	onCreateNote,
	onCreateNotebook,
}: Pick<NoteViewProps, 'onCreateNote' | 'onCreateNotebook'>) => {
	if (onCreateNote !== undefined) {
		return rich('notes.view.nothingOpen', {
			create: (words) => (
				<button type="button" className="link-button" onClick={onCreateNote}>
					{words}
				</button>
			),
		});
	}
	if (onCreateNotebook !== undefined) {
		return rich('notes.view.noNotebook', {
			create: (words) => (
				<button type="button" className="link-button" onClick={onCreateNotebook}>
					{words}
				</button>
			),
		});
	}
	return t('notes.view.selectNote');
};

/**
 * The caret into a scratch note's body as it opens (`ScratchEditing`), once
 * there is an editor to put it in: the rich editor is built a frame or more
 * after the note mounts. Given up after a second, and never taken from a field
 * the user has got to first.
 */
const useFocusBody = (wanted: boolean, noteId: string | undefined, body: Element | null) => {
	useEffect(() => {
		if (!wanted || noteId === undefined || body === null) return undefined;
		const state = { frame: 0, left: 60 };
		const attempt = () => {
			const editor = body.querySelector<HTMLElement>('.ProseMirror');
			if (editor !== null) {
				if (!inAField()) editor.focus();
				return;
			}
			state.left -= 1;
			if (state.left > 0) state.frame = requestAnimationFrame(attempt);
		};
		state.frame = requestAnimationFrame(attempt);
		return () => {
			cancelAnimationFrame(state.frame);
		};
	}, [wanted, noteId, body]);
};

const scratchScreen = (
	scratch: ScratchEditing | undefined,
	note: NoteRecord,
	onMark: (change: MarkChange) => void,
	deleteOne: ((note: NoteRecord) => void) | undefined
): ScratchScreen | undefined =>
	scratch === undefined
		? undefined
		: {
				...scratch,
				marks: scratchMarks(note),
				onMark,
				onDelete:
					deleteOne === undefined
						? undefined
						: () => {
								deleteOne(note);
							},
			};

/** Pin or colour a scratch note, storing it first if it is a draft. */
const useScratchMarking = (note: NoteRecord | undefined, draft: NoteDraft | undefined) => {
	const db = useDb();
	return useCallback(
		(change: MarkChange) => {
			if (note === undefined) return;
			const { id, connectionId } = note;
			const marked = () => setScratchMarks(db, id, change, { connectionId });
			if (draft === undefined) {
				void marked();
				return;
			}
			void draft.store().then((stored) => (stored ? marked() : undefined));
		},
		[note, draft, db]
	);
};

export const NoteView = ({
	note,
	onDeleted,
	onCreateNote,
	onCreateNotebook,
	opening = false,
	draft,
	scratch,
	ref: handle,
}: NoteViewProps) => {
	const noteId = note?.id;
	const isScratch = scratch !== undefined;
	const {
		mode,
		unsupported,
		failing,
		overtaken,
		addedInVisit,
		onUserEdit,
		rename,
		deleteOne,
		toggleMode,
	} = useNoteSession({
		note,
		draft,
		onDeleted,
		isScratch,
	});
	useImperativeHandle(handle, () => ({ deleteNote: deleteOne }), [deleteOne]);
	const { retryable } = unsupported;
	const locked = unsupported.lost !== undefined;
	const mark = useScratchMarking(note, draft);

	// The element the outline shares the room of, as state rather than a ref:
	// a note opening mounts it, and the width has to be asked of the new one.
	const [body, setBody] = useState<HTMLDivElement | null>(null);
	const layout = useNoteLayout(noteId, body, isScratch);
	useFocusBody(scratch?.focusBody === true, noteId, body);

	// A count of askings rather than a boolean: asking again with the bar already
	// open re-focuses and selects its field, which is what `Mod+F` does
	// everywhere else, and the bar needs to be able to tell one asking from the
	// next to do it.
	const [finding, setFinding] = useState(0);
	useCommand({
		id: 'note.find',
		label: t('notes.commands.find'),
		group: t('shell.commands.group.note'),
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
		label: t(`notes.commands.editAs.${otherMode(mode ?? 'rich')}`),
		group: t('shell.commands.group.note'),
		chord: MODE_TOGGLE,
		// A scratch note's editor has no other editor to go to, but a note held
		// in raw mode can still ask the rich one again.
		enabled:
			noteId !== undefined &&
			mode !== undefined &&
			(isScratch ? locked && retryable : !locked || retryable),
		run: toggleMode,
	});

	if (note === undefined) {
		return (
			<section
				className="note-view empty"
				aria-label={t('notes.view.label')}
				aria-busy={opening || undefined}
			>
				{opening ? (
					<Opening />
				) : (
					<p className="muted placeholder">
						<NothingOpen
							onCreateNote={onCreateNote}
							onCreateNotebook={onCreateNotebook}
						/>
					</p>
				)}
			</section>
		);
	}

	return (
		<FindTargetProvider>
			<NoteScreen
				note={note}
				mode={mode}
				lost={unsupported.lost}
				retryable={retryable}
				unsaved={failing}
				finding={finding}
				layout={layout}
				onBody={setBody}
				toggleMode={toggleMode}
				onClose={() => {
					setFinding(0);
				}}
				begun={draft !== undefined}
				draft={draft}
				onRename={rename}
				onTitleDone={() => {
					focusEditor(body);
				}}
				onUserEdit={onUserEdit}
				onUnsupported={unsupported.report}
				// A body from outside is on screen now. What was typed before it
				// is not under whatever is typed next — a new sitting, so the next
				// edit cannot stand for a held one — and what is still pending was
				// not typed over it: saved as the body, it would put text the
				// editor no longer shows over the text it does.
				onAdopted={overtaken}
				onAdded={addedInVisit}
				scratch={scratchScreen(
					scratch,
					note,
					mark,
					draft === undefined ? deleteOne : undefined
				)}
			/>
		</FindTargetProvider>
	);
};
