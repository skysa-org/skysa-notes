import { DeletedNotice } from '../../components/list/DeletedNotice.js';
import { type Notice, useShownNotices } from '../../components/ui/notices.js';
import { Toast } from '../../components/ui/Toast.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { nameShown } from '../../store/titles.js';

/**
 * The shell's toasts, in one stack: the undo of a delete, what connecting
 * storage came to, what was said about the last thing asked for, and what
 * stays until it is read (`NoticesProvider`).
 */
export const HomeToasts = ({
	deleted,
	undoDelete,
	dismissDeleted,
	undoFailed,
	connectNotice,
	dismissConnect,
}: Readonly<{
	/** The note just deleted, while its undo is offered (`useUndoDelete`). */
	deleted: NoteRecord | null;
	undoDelete: () => void;
	dismissDeleted: () => void;
	/** The `noteRef` of a delete whose undo failed, whose notice stays. */
	undoFailed: string | null;
	connectNotice: Notice | undefined;
	dismissConnect: () => void;
}>) => {
	const { passing, staying, dismissPassing, dismissStaying } = useShownNotices();
	return (
		<div className="toast-stack">
			{deleted !== null && (
				<DeletedNotice
					// A second delete is a new notice with a new clock, not the
					// first one's time running on under another note's name.
					key={noteRef(deleted)}
					title={nameShown(deleted)}
					onUndo={undoDelete}
					onDismiss={dismissDeleted}
					keep={undoFailed === noteRef(deleted)}
				/>
			)}
			{connectNotice !== undefined && (
				<Toast
					message={connectNotice.message}
					tone={connectNotice.tone}
					action={connectNotice.action}
					onDismiss={dismissConnect}
				/>
			)}
			{passing !== null && (
				<Toast
					message={passing.message}
					tone={passing.tone}
					action={passing.action}
					onDismiss={dismissPassing}
				/>
			)}
			{staying !== null && (
				<Toast
					message={staying.message}
					tone={staying.tone}
					action={staying.action}
					onDismiss={dismissStaying}
				/>
			)}
		</div>
	);
};
