import { fileKind } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { FILE_ICONS, Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import { activeConnectionId, db, type NotesDatabase } from '../store/db.js';
import {
	type AttachedFile,
	attachedFiles,
	deleteUnlinkedFiles,
	everyNoteHeld,
} from '../store/fileLinks.js';
import { titleShown } from '../store/titles.js';

/**
 * The files in a notebook, each with the notes that link it under its name,
 * and Delete for one that none does (2026-10-04). Offered from the notebook's
 * `⋯` where it has files (`NotebookMenu.tsx`).
 *
 * A file nothing links is one the user took out of every note, or whose notes
 * were deleted, and nothing else would ever show it to them. A note that names
 * the file anywhere counts as linking it (`store/fileLinks.ts`). One linked only
 * by a note deleted here and not yet sent says so, and cannot be deleted: the
 * note's delete can still be undone. Nothing can be deleted at all while the
 * device may not hold every note in the source — importing, say — and the
 * dialog says so.
 *
 * Of the source in front when it was opened, held for as long as it is: a
 * Delete pressed after the sources changed is still about the files listed.
 * The list is live, so a link a pull brings or a delete elsewhere shows at once
 * — and the store asks again before it deletes anything (`deleteUnlinkedFiles`).
 */

export interface AttachedFilesProps {
	/** The notebook's name, as its row shows it. */
	name: string;
	path: string;
	onClose: () => void;
	database?: NotesDatabase;
}

/** A size as a person reads one. */
export const sizeOf = (bytes: number): string => {
	if (bytes < 1024) return t('attachedFiles.size.bytes', { count: bytes });
	if (bytes < 1024 * 1024) {
		return t('attachedFiles.size.kilobytes', { count: Math.round(bytes / 1024) });
	}
	return t('attachedFiles.size.megabytes', {
		count: Math.round((bytes / (1024 * 1024)) * 10) / 10,
	});
};

/** Where a file is linked from, in words: the notes, a deleted one said so. */
export const linkedFrom = (file: AttachedFile): string =>
	file.linkedBy.length === 0
		? t('attachedFiles.notLinked')
		: t('attachedFiles.linkedIn', {
				notes: file.linkedBy
					.map((note) =>
						note.deleted
							? t('attachedFiles.deletedNote', { title: titleShown(note.title) })
							: titleShown(note.title)
					)
					.join(', '),
			});

const FileRow = ({
	file,
	deletable,
	onDelete,
}: {
	file: AttachedFile;
	/** Whether a file no note links can be deleted from here at all. */
	deletable: boolean;
	onDelete: (file: AttachedFile) => Promise<void>;
}) => {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const offered = file.linkedBy.length === 0 && deletable;
	const deleteButton = useRef<HTMLButtonElement>(null);
	const keepButton = useRef<HTMLButtonElement>(null);
	const asked = useRef(false);

	// The button pressed goes as the question comes and goes: the focus goes
	// to Keep, which answers it safely, and back to Delete after.
	useEffect(() => {
		const was = asked.current;
		asked.current = asking;
		if (asking) {
			keepButton.current?.focus();
			return;
		}
		if (was) deleteButton.current?.focus();
	}, [asking]);

	return (
		<li className="attached-file">
			<span className="attached-file-icon" aria-hidden="true">
				<Icon name={FILE_ICONS[fileKind(file.name)]} />
			</span>
			<span className="attached-file-name">{file.name}</span>
			<span className="attached-file-size muted">{sizeOf(file.size)}</span>
			<span className="attached-file-notes muted">{linkedFrom(file)}</span>
			{offered && !asking && (
				<button
					ref={deleteButton}
					type="button"
					className="danger attached-file-delete"
					aria-label={t('attachedFiles.deleteLabel', { name: file.name })}
					onClick={() => {
						setAsking(true);
					}}
				>
					{t('attachedFiles.delete')}
				</button>
			)}
			{offered && asking && (
				<span
					className="attached-file-confirm"
					role="group"
					aria-label={t('attachedFiles.deleteLabel', { name: file.name })}
				>
					<span>{t('attachedFiles.confirm')}</span>
					<button
						type="button"
						className="danger"
						disabled={busy}
						onClick={() => {
							setBusy(true);
							void onDelete(file).finally(() => {
								setBusy(false);
								setAsking(false);
							});
						}}
					>
						{t('attachedFiles.delete')}
					</button>
					<button
						ref={keepButton}
						type="button"
						disabled={busy}
						onClick={() => {
							setAsking(false);
						}}
					>
						{t('attachedFiles.keep')}
					</button>
				</span>
			)}
		</li>
	);
};

export const AttachedFiles = ({ name, path, onClose, database = db }: AttachedFilesProps) => {
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const [connectionId, setConnectionId] = useState<string>();
	const [problem, setProblem] = useState<string>();
	useSuspendShortcuts();

	useEffect(() => {
		void activeConnectionId(database).then(setConnectionId);
	}, [database]);

	const files = useLiveQuery(
		() =>
			connectionId === undefined ? undefined : attachedFiles(database, connectionId, path),
		[database, connectionId, path]
	);
	const held = useLiveQuery(
		() => (connectionId === undefined ? undefined : everyNoteHeld(database, connectionId)),
		[database, connectionId]
	);

	useEffect(() => {
		const back = document.activeElement;
		close.current?.focus();
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
	}, []);

	// On the document, not the dialog: a button that goes as it is pressed
	// leaves the focus nowhere, and Escape and Tab must still be the dialog's.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const buttons = [...element.querySelectorAll('button:not(:disabled)')];
			const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
			event.preventDefault();
			(buttons[next] as HTMLButtonElement | undefined)?.focus();
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
		};
	}, [onClose]);

	const remove = async (file: AttachedFile): Promise<void> => {
		if (connectionId === undefined) return;
		setProblem(undefined);
		try {
			const gone = await deleteUnlinkedFiles(database, connectionId, [file.id]);
			// Linked since the list was drawn: the live list shows by what.
			if (gone.length === 0) setProblem(t('attachedFiles.kept', { name: file.name }));
		} catch {
			setProblem(t('attachedFiles.failed', { name: file.name }));
		}
		close.current?.focus();
	};

	return createPortal(
		<div className="modal-backdrop">
			<div
				ref={dialog}
				className="modal attached-files"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
			>
				<h2 id={titleId}>{t('attachedFiles.title', { name })}</h2>
				{files !== undefined && files.length === 0 && (
					<p className="muted">{t('attachedFiles.none')}</p>
				)}
				{held === false && files !== undefined && files.length > 0 && (
					<p className="muted">{t('attachedFiles.notAllHere')}</p>
				)}
				{files !== undefined && files.length > 0 && (
					<ul className="attached-file-list">
						{files.map((file) => (
							<FileRow
								key={file.id}
								file={file}
								deletable={held === true}
								onDelete={remove}
							/>
						))}
					</ul>
				)}
				{problem !== undefined && (
					<p className="muted" role="alert">
						{problem}
					</p>
				)}
				<div className="modal-actions">
					<button ref={close} type="button" onClick={onClose}>
						{t('common.close')}
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};
