import { DeletedNotice } from '../../components/list/DeletedNotice.js';
import { type Notice, useShownNotices } from '../../components/ui/notices.js';
import { Toast } from '../../components/ui/Toast.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { nameShown } from '../../store/titles.js';

const NoticeToast = ({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) => (
	<Toast
		message={notice.message}
		tone={notice.tone}
		action={notice.action}
		onDismiss={onDismiss}
	/>
);

/**
 * The shell's toasts, in one stack: the undo of a delete, what connecting
 * storage came to, and what was said and what was kept (`Notices`).
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
				<NoticeToast notice={connectNotice} onDismiss={dismissConnect} />
			)}
			{passing !== null && <NoticeToast notice={passing} onDismiss={dismissPassing} />}
			{staying !== null && <NoticeToast notice={staying} onDismiss={dismissStaying} />}
		</div>
	);
};
