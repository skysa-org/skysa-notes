import { fileKind } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';

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
import { Dialog, DialogActions, InlineDialog } from './ui/Dialog.js';

/**
 * The files in a notebook, each with the notes that link it under its name,
 * and Delete for one that none does (2026-10-04). Offered from the notebook's
 * `⋯` where it has files (`sidebar/NotebookMenu.tsx`).
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
const linkedFrom = (file: AttachedFile): string =>
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
	const asked = useRef(false);

	// The button pressed goes as the question comes, which takes the focus as
	// every question does (`InlineDialog`); answered without deleting, it is
	// given back to Delete.
	useEffect(() => {
		const was = asked.current;
		asked.current = asking;
		if (was && !asking) deleteButton.current?.focus();
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
				<InlineDialog
					className="attached-file-confirm"
					label={t('attachedFiles.deleteLabel', { name: file.name })}
					onClose={() => {
						if (!busy) setAsking(false);
					}}
				>
					<span>{t('attachedFiles.confirm')}</span>
					<DialogActions
						primary={
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
						}
					/>
				</InlineDialog>
			)}
		</li>
	);
};

export const AttachedFiles = ({ name, path, onClose, database = db }: AttachedFilesProps) => {
	const [connectionId, setConnectionId] = useState<string>();
	const [problem, setProblem] = useState<string>();

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
	};

	return (
		<Dialog
			title={t('attachedFiles.title', { name })}
			className="attached-files"
			onClose={onClose}
			cancel={false}
		>
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
			<DialogActions />
		</Dialog>
	);
};
