import { DeletedNotice } from '../../components/list/DeletedNotice.js';
import type { Notice } from '../../components/ui/notify.js';
import { Toast } from '../../components/ui/Toast.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { nameShown } from '../../store/titles.js';

/**
 * The shell's toasts, in one stack: the undo of a delete, what connecting
 * storage came to, a problem the shell met, and what a component told it
 * (`NotifyContext`).
 */
export const HomeToasts = ({
	deleted,
	undoDelete,
	dismissDeleted,
	undoFailed,
	connectNotice,
	dismissConnect,
	problem,
	dismissProblem,
	told,
	dismissTold,
}: Readonly<{
	/** The note just deleted, while its undo is offered (`useUndoDelete`). */
	deleted: NoteRecord | null;
	undoDelete: () => void;
	dismissDeleted: () => void;
	/** The `noteRef` of a delete whose undo failed, whose notice stays. */
	undoFailed: string | null;
	connectNotice: Notice | undefined;
	dismissConnect: () => void;
	problem: Notice | null;
	dismissProblem: () => void;
	told: Notice | null;
	dismissTold: () => void;
}>) => (
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
		{problem !== null && (
			<Toast
				message={problem.message}
				tone={problem.tone}
				action={problem.action}
				onDismiss={dismissProblem}
			/>
		)}
		{told !== null && (
			<Toast
				message={told.message}
				tone={told.tone}
				action={told.action}
				onDismiss={dismissTold}
			/>
		)}
	</div>
);
