import { useCallback, useState } from 'react';

import { useCommand } from '../../commands/context.js';
import type { RichEditorProps } from '../../editor/RichEditor.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { useFormatToolbarShown } from '../../store/hooks.js';
import { setFormatToolbarShown } from '../../store/prefs.js';
import {
	COARSE_POINTER,
	COMPACT,
	OUTLINE_FITS_AT,
	OUTLINE_OPENS_AT,
	rems,
	useElementWidth,
	useMediaQuery,
} from '../ui/layout.js';

/**
 * What of the note's furniture there is room for: the outline beside it, and
 * where the formatting toolbar goes.
 *
 * **The outline** is sized by the note's own width, not the window's — the
 * same window gives the note very different room with the columns beside it
 * and without them. At 53.5rem and wider it starts open (`OUTLINE_OPENS_AT`),
 * below that it starts collapsed and is a press away. Once pressed it stays as
 * the user left it for as long as the app is open, whatever the room does.
 * Below 36rem (`OUTLINE_FITS_AT`), where a rail would leave the note narrower
 * than itself, and in a compact window on a touch screen — a phone on its side,
 * a small tablet — it is a **flyout** over the editor instead: shut until asked for, and shut
 * again once a heading is chosen, on Escape, on a press anywhere else, and on
 * opening another note — it covers what it is for, so it goes once used.
 * Unmounted rather than hidden
 * when it is not shown: the headings are re-read when it comes back, which is
 * one parse of one note, and a rail that is not there cannot be tabbed
 * through.
 *
 * **The toolbar** is across the top in a wide window, as it always was. In a
 * compact one it is hidden until asked for and then sits at the bottom of the
 * editor, under the thumb: the screen is too short to spend a row of buttons
 * above every note, and the inline toolbar and the slash menu are still there
 * without it. Once asked for it stays, on this device, until it is asked away
 * again — a reload included (`FORMAT_TOOLBAR_KEY`).
 */
export const useNoteLayout = (
	noteId: string | undefined,
	body: Element | null,
	scratch: boolean
) => {
	const db = useDb();
	const compact = useMediaQuery(COMPACT);
	const width = useElementWidth(body);
	const outlineFits = width === undefined || width >= rems(OUTLINE_FITS_AT);
	const outlineOpens = width === undefined || width >= rems(OUTLINE_OPENS_AT);

	const touch = useMediaQuery(COARSE_POINTER);
	const flyout = !outlineFits || (compact && touch);

	const [outlineChoice, setOutlineChoice] = useState<boolean | null>(null);
	// Which note the flyout is open over, so that opening another closes it
	// without an effect to notice the change.
	const [flyoutOver, setFlyoutOver] = useState<string | undefined>(undefined);
	const flyoutOpen = noteId !== undefined && flyoutOver === noteId;
	const showOutline = flyout ? flyoutOpen : (outlineChoice ?? outlineOpens);
	const toggleOutline = useCallback(() => {
		if (flyout) setFlyoutOver(flyoutOpen ? undefined : noteId);
		else setOutlineChoice(!showOutline);
	}, [flyout, flyoutOpen, noteId, showOutline]);
	const closeOutline = useCallback(() => {
		setFlyoutOver(undefined);
	}, []);
	useCommand({
		id: 'note.outline',
		label: showOutline ? t('notes.commands.hideOutline') : t('notes.commands.showOutline'),
		group: t('shell.commands.group.note'),
		// A scratch note's editor has no outline.
		enabled: noteId !== undefined && !scratch,
		run: toggleOutline,
	});

	// Hidden until the store has answered, which is before the note has: both
	// are reads of the same database, and the note's is the larger.
	const toolbarShown = useFormatToolbarShown() ?? false;
	const bottom = toolbarShown ? 'bottom' : 'none';
	const toolbar: RichEditorProps['toolbar'] = compact ? bottom : 'top';
	const toggleToolbar = useCallback(() => {
		void setFormatToolbarShown(db, !toolbarShown);
	}, [toolbarShown, db]);

	return {
		compact,
		flyout,
		touch,
		showOutline,
		toggleOutline,
		closeOutline,
		toolbar,
		toggleToolbar,
	};
};

/** How the note is laid out in the room it has (`useNoteLayout`). */
export type NoteLayout = ReturnType<typeof useNoteLayout>;
