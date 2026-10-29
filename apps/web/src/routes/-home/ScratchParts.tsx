import { ScratchModal, Scratchpad } from '../../components/Scratchpad.js';
import { NameDialog } from '../../components/ui/NameDialog.js';
import type { useScratchpad } from '../../components/useScratchpad.js';
import { t } from '../../i18n/t.js';
import type { LiveEdits } from '../../store/liveEdits.js';
import { scratchMarks } from '../../store/scratchpad.js';
import type { NotePane } from './NoteColumn.js';

/**
 * The scratchpad's parts of the shell: its pane, in the notes' place, and
 * what it puts over the page. Each is told what `useScratchpad` holds, and
 * handed the shell's note pane as `editor`.
 */

type Scratch = ReturnType<typeof useScratchpad>;

/** The scratchpad, in the notes' place. */
export const ScratchPane = ({
	scratch,
	liveEdits,
	editor,
}: Readonly<{
	scratch: Scratch;
	liveEdits: LiveEdits;
	editor: NotePane;
}>) => (
	<Scratchpad
		notes={scratch.notes}
		takingId={scratch.takingId}
		editor={scratch.taking ? editor(scratch.editing) : undefined}
		onTake={scratch.take}
		onCloseTake={scratch.closeTake}
		openId={scratch.card?.id}
		openingId={scratch.openingId}
		onOpen={scratch.open}
		onMark={scratch.mark}
		onMove={scratch.offered}
		onDelete={scratch.remove}
		liveEdits={liveEdits}
	/>
);

/** What the scratchpad puts over the page: a card's dialog, and the name it asks for. */
export const ScratchOverlays = ({
	scratch,
	editor,
}: Readonly<{
	scratch: Scratch;
	editor: NotePane;
}>) => (
	<>
		{scratch.modal && scratch.card !== undefined && (
			<ScratchModal
				id={scratch.card.id}
				color={scratchMarks(scratch.card).color}
				onClose={scratch.close}
			>
				{editor(scratch.editing)}
			</ScratchModal>
		)}
		{scratch.naming !== undefined && (
			<NameDialog
				title={t('shell.nameNote.title')}
				text={t('shell.nameNote.text')}
				label={t('shell.nameNote.label')}
				confirmLabel={t('shell.nameNote.confirm')}
				onConfirm={scratch.named}
				onCancel={scratch.cancelNaming}
			/>
		)}
	</>
);
