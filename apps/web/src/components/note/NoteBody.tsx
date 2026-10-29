import type { StructuralDifference } from '@skysa/core';
import { type ReactNode, useCallback, useRef } from 'react';

import { useCommand } from '../../commands/context.js';
import type { EditorMode } from '../../editor/mode.js';
import { RawEditor } from '../../editor/RawEditor.js';
import { RichEditor, type RichEditorProps } from '../../editor/RichEditor.js';
import { t } from '../../i18n/t.js';
import type { NoteRecord } from '../../store/db.js';
import { useNoteAttachments } from '../attachments/noteAttachments.js';
import { useNoteSecrets } from '../secrets/noteSecrets.js';
import { Outline } from './Outline.js';
import type { NoteDraft, NoteViewProps } from './types.js';

/**
 * Whichever editor is open, with the outline beside it.
 *
 * Its own component because the rail needs an element to look inside: `body`
 * is the one both the editor and the outline are under, and only this part of
 * the tree cares.
 */
export const NoteBody = ({
	note,
	mode,
	showOutline,
	flyout,
	focusEditor,
	onCloseOutline,
	toolbar,
	onUserEdit,
	onProblem,
	draft,
	onUnsupported,
	onAdopted,
	onBody,
	onAdded,
	basic,
	toolbarEnd,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	showOutline: boolean;
	/** Over the editor rather than beside it (`useNoteLayout`). */
	flyout: boolean;
	/** Whether jumping to a heading puts the caret there (`OutlineProps`). */
	focusEditor: boolean;
	onCloseOutline: () => void;
	toolbar: RichEditorProps['toolbar'];
	onUserEdit: (body: string, origin: string) => void;
	onProblem: NoteViewProps['onProblem'];
	/** Stored before a file is added to it, as before the first keystroke. */
	draft: NoteDraft | undefined;
	onUnsupported: (lost: StructuralDifference) => void;
	onAdopted: () => void;
	/** The element, for whoever sizes the outline by its width. */
	onBody: (element: HTMLDivElement | null) => void;
	/** A file was put in the note (`useFileCleanup`). */
	onAdded: (path: string) => void;
	/** A scratch note's editor (`RichEditorProps.basic`). */
	basic: boolean;
	/** On the toolbar's row, in rich text (`RichEditorProps.toolbarEnd`). */
	toolbarEnd: ReactNode;
}) => {
	const body = useRef<HTMLDivElement>(null);
	const attachments = useNoteAttachments(note, {
		report: onProblem,
		store: draft?.store,
		onAdded,
	});
	// Either editor's, through the one open: the toolbar's paperclip and the
	// slash menu are the rich editor's, and this is raw mode's only way.
	useCommand({
		id: 'note.attach',
		label: t('notes.commands.attach'),
		group: t('shell.commands.group.note'),
		enabled: mode !== undefined,
		run: attachments.pick,
	});
	const secrets = useNoteSecrets(note, { report: onProblem });
	// Either editor's, as "Attach files" is.
	useCommand({
		id: 'note.insertSecret',
		label: t('notes.commands.insertSecret'),
		group: t('shell.commands.group.note'),
		enabled: mode !== undefined,
		run: secrets.insert,
	});
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
					attachments={attachments}
					secrets={secrets.host}
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
					attachments={attachments}
					secrets={secrets.host}
					basic={basic}
					toolbarEnd={toolbarEnd}
				/>
			)}
			{secrets.dialog}
			{showOutline && (
				<Outline
					body={note.body}
					// Read when a row is clicked, not when it is drawn: the
					// editor is a sibling that mounts and unmounts with the mode,
					// so a reference taken at render time is stale the moment the
					// mode changes.
					editor={() => body.current?.querySelector('.editor') ?? null}
					focusEditor={focusEditor}
					{...(flyout ? { onClose: onCloseOutline } : {})}
				/>
			)}
		</div>
	);
};
