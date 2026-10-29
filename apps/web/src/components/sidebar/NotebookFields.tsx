import { basename } from '@skysa/core';
import { useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import type { Moving } from '../../store/rearrange.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';

/**
 * Inline rather than a `prompt()`: a modal browser dialog blocks the page, is
 * unstyleable, and behaves badly in an installed PWA.
 */
interface NewFolderFieldProps {
	/** Where the notebook will go, or undefined for the top level. */
	parentPath: string | undefined;
	onCancel: () => void;
	onSubmit: (name: string) => void;
}

export const NewFolderField = ({ parentPath, onCancel, onSubmit }: NewFolderFieldProps) => {
	const [name, setName] = useState('');
	const field = useRef<HTMLInputElement>(null);

	// The field appears in response to a click, so moving focus into it is what
	// the user asked for — unlike `autoFocus` on page load, which jsx-a11y
	// rightly rejects. A keyboard user would otherwise have to hunt for the
	// field they just opened.
	useEffect(() => {
		field.current?.focus();
	}, []);

	const submit = () => {
		const trimmed = name.trim();
		if (trimmed === '') {
			onCancel();
			return;
		}
		onSubmit(trimmed);
	};

	return (
		<input
			className="new-folder"
			// The field is in the header wherever the notebook is going, so where
			// that is has to be in the words: the two cases are one keystroke
			// apart and land in different places.
			aria-label={
				parentPath === undefined
					? t('notebooks.newName.label')
					: t('notebooks.newName.insideLabel', { name: basename(parentPath) })
			}
			placeholder={
				parentPath === undefined
					? t('notebooks.newName.placeholder')
					: t('notebooks.newName.insidePlaceholder', { name: basename(parentPath) })
			}
			ref={field}
			value={name}
			onChange={(event) => {
				setName(event.target.value);
			}}
			onBlur={submit}
			onKeyDown={(event) => {
				if (event.key === 'Enter') submit();
				if (event.key === 'Escape') onCancel();
			}}
		/>
	);
};

/**
 * What the sidebar says while something is in the air, and the reason the
 * dragging is not the only way to do this.
 *
 * Dragging is a pointer gesture, and WCAG 2.2 asks that anything it can do be
 * doable with a single pointer that does not drag (SC 2.5.7) — a keyboard user
 * and a user with a tremor both need the same moves. The answer here is that
 * picking up is a *command* (`notebook.move`, `note.move` in the route, so they
 * are in the palette like everything else — docs/ARCHITECTURE.md §7, "Commands are
 * declared, not collected") and putting down is a click on the destination row.
 * That is the same mode a drag enters, so there is one implementation and not
 * two: `moving` is set by the command or by `dragstart`, and read here and by
 * every row below without either of them knowing which it was.
 */
export const MoveHint = ({ moving, onCancel }: { moving: Moving; onCancel: () => void }) => (
	<p className="move-hint">
		{/* The live region is the sentence alone: the way out is a control to
		    reach, not news to be read out every time the hint changes. Escape
		    still puts the thing down too (the route listens for it). */}
		<span role="status">{t('notebooks.move.hint', { name: moving.name })}</span>{' '}
		<button type="button" className="link-button" onClick={onCancel}>
			{t('common.cancel')}
		</button>
	</p>
);

/**
 * What deleting a notebook takes, in words. The files too: a file beside a note
 * is deleted with its notebook and in no other way (#187), so this is the one
 * place the user is told it will go.
 */
const deletionOf = (name: string, noteCount: number, fileCount: number): string => {
	if (noteCount === 0 && fileCount === 0) return t('notebooks.delete.nothingInside', { name });
	if (fileCount === 0) return t('notebooks.delete.notes', { name, count: noteCount });
	if (noteCount === 0) return t('notebooks.delete.files', { name, count: fileCount });
	// Two counts in one sentence: its words follow the notes', and the files
	// are a phrase counted on its own.
	return t('notebooks.delete.notesAndFiles', {
		name,
		count: noteCount,
		files: t('notebooks.delete.fileCount', { count: fileCount }),
	});
};

/**
 * Asked before a notebook goes, and not told afterwards — the rule the
 * disconnect confirm exists for (docs/ARCHITECTURE.md §10), and the reason a notebook
 * needs one where a note does not: a note comes back from the notice that
 * follows it, and a notebook takes every note beneath it with it. So the count
 * is in the question, because that is the part the user may not know.
 *
 * Over the page rather than wedged under the pane header, where it pushed the
 * tree down and read as a row of it (`ConfirmDialog`).
 */
export const DeleteConfirm = ({
	name,
	noteCount,
	fileCount,
	onConfirm,
	onCancel,
}: {
	name: string;
	noteCount: number;
	fileCount: number;
	onConfirm: () => void;
	onCancel: () => void;
}) => (
	<ConfirmDialog
		title={t('notebooks.delete.title')}
		confirmLabel={t('notebooks.delete.confirm')}
		tone="danger"
		onConfirm={onConfirm}
		onCancel={onCancel}
	>
		{deletionOf(name, noteCount, fileCount)}
	</ConfirmDialog>
);
