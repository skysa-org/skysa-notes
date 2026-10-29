import { isVaultPath } from '@skysa/core';
import type { ReactNode } from 'react';

import type { ScratchEditing } from '../../components/note/types.js';
import { PasswordItem, type PasswordItemProps } from '../../components/passwords/PasswordItem.js';
import { CardSheet } from '../../components/scratchpad/Scratchpad.js';
import { t } from '../../i18n/t.js';
import type { NoteRecord } from '../../store/db.js';
import { isLive } from '../../store/rowStates.js';

/**
 * The shell's third column: the note open (`NoteColumn`), or in the
 * passwords the item open (`PasswordColumn`). The note pane itself is the
 * shell's, handed in as `editor`: one is ever mounted, wherever the note open
 * is shown.
 */

/** The shell's note pane, as a place shows it: with the scratchpad's part, or without. */
export type NotePane = (scratchNote?: ScratchEditing) => ReactNode;

/** The column with nothing in it, or only a line about what is coming. */
const EmptyPane = ({ children }: Readonly<{ children?: ReactNode }>) => (
	<section className="note-view empty" aria-label={t('shell.notePane')}>
		{children}
	</section>
);

/**
 * What is in the note's column in the scratchpad: in a compact window, the
 * card open, full screen; nothing open, an empty pane behind the
 * scratchpad's. In a wide one the scratchpad has the column too.
 */
export const NoteColumn = ({
	inScratchpad,
	compact,
	cardId,
	unseen,
	editing,
	editor,
}: Readonly<{
	inScratchpad: boolean;
	compact: boolean;
	/** The scratch card open, if any (`useScratchpad`). */
	cardId: string | undefined;
	/** Whether a pane is open over the card, as a dropdown. */
	unseen: boolean;
	/** The note pane's part in the scratchpad (`useScratchpad`). */
	editing: ScratchEditing;
	editor: NotePane;
}>) => {
	if (!inScratchpad) return editor();
	if (!compact) return null;
	if (cardId !== undefined) {
		// A pane open with a card open is a dropdown over it: nothing rests
		// under a card (`useScratchpad`).
		return (
			<CardSheet id={cardId} unseen={unseen}>
				{editor(editing)}
			</CardSheet>
		);
	}
	return <EmptyPane />;
};

/**
 * What is in the note's column in the passwords: the item open, or, with
 * none, what to do, or in a compact window an empty pane behind the list.
 * Keyed by the item, so nothing one showed is there as another opens.
 */
export const PasswordColumn = ({
	openNote,
	opening,
	compact,
	draft,
	onProblem,
	onDelete,
	onClose,
	onOpen,
}: Readonly<
	Pick<PasswordItemProps, 'draft' | 'onProblem' | 'onDelete' | 'onClose' | 'onOpen'> & {
		openNote: NoteRecord | undefined;
		opening: boolean;
		compact: boolean;
	}
>) => {
	if (openNote !== undefined && isLive(openNote) && isVaultPath(openNote.path)) {
		return (
			<PasswordItem
				key={openNote.id}
				note={openNote}
				draft={draft}
				onProblem={onProblem}
				onDelete={onDelete}
				onClose={onClose}
				onOpen={onOpen}
			/>
		);
	}
	if (compact) return <EmptyPane />;
	return (
		<EmptyPane>
			<p className="muted placeholder">
				{opening ? t('passwords.item.opening') : t('passwords.none')}
			</p>
		</EmptyPane>
	);
};
