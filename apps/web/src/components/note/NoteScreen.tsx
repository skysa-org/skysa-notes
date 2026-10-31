import { frontmatterIsEditable, headings, type StructuralDifference } from '@skysa/core';
import { type ReactNode, useMemo } from 'react';

import { t } from '../../i18n/t.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { type EditorMode, MODE_LABELS } from '../../store/editorMode.js';
import { shownFolder, useRenaming } from '../../store/renaming.js';
import { titleShown } from '../../store/titles.js';
import { PinButton, ScratchBar } from '../scratchpad/ScratchControls.js';
import { useRenamings } from '../shell/context.js';
import { Icon, type IconName } from '../ui/icons.js';
import { FindBar } from './FindBar.js';
import { NoteBody } from './NoteBody.js';
import { TitleField } from './TitleField.js';
import type { NoteDraft, ScratchScreen } from './types.js';
import { UnsupportedBanner } from './unsupported.js';
import type { NoteLayout } from './useNoteLayout.js';

// Markdown is drawn as code: the `M↓` mark it had was a box of small strokes
// that could not be told from the rich text icon beside it at a glance.
const MODE_ICONS: Record<EditorMode, IconName> = { rich: 'rich-text', raw: 'code' };

const tabTitle = (
	tab: EditorMode,
	current: boolean,
	locked: boolean,
	retryable: boolean
): string => {
	if (current) return t(`notes.view.mode.editing.${tab}`);
	if (locked && retryable) return t(`notes.view.mode.retry.${tab}`);
	if (locked) return t('notes.view.mode.locked');
	return t(`notes.view.mode.switchTo.${tab}`);
};

/**
 * The two editors as a pair of tabs, the one in use pressed. Two buttons
 * rather than one that names the mode it is in: a single toggle labelled with
 * where you are reads as where it will take you, and an icon cannot carry the
 * difference at all.
 *
 * Pressing the tab already in use does nothing. A note the rich editor cannot
 * represent keeps its markdown tab, pressed, and the rich one is disabled until
 * the note has been changed, when pressing it asks the rich editor again.
 */
const ModeTabs = ({
	mode,
	locked,
	retryable,
	toggleMode,
}: {
	mode: EditorMode;
	locked: boolean;
	retryable: boolean;
	toggleMode: () => void;
}) => (
	<div className="mode-tabs" role="group" aria-label={t('notes.view.editor')}>
		{(['rich', 'raw'] as const).map((tab) => {
			const current = tab === mode;
			return (
				<button
					key={tab}
					type="button"
					aria-label={MODE_LABELS[tab]}
					aria-pressed={current}
					disabled={!current && locked && !retryable}
					title={tabTitle(tab, current, locked, retryable)}
					onClick={() => {
						if (!current) toggleMode();
					}}
				>
					<Icon name={MODE_ICONS[tab]} />
				</button>
			);
		})}
	</div>
);

/**
 * Where the note is, with its notebook under the name being typed while it is
 * renamed. Its own component, so a keystroke redraws the path and not the note.
 */
const NotePath = ({ path }: { path: string }) => {
	const shown = shownFolder(path, useRenaming(useRenamings()));
	return (
		<span className="muted path" title={shown}>
			{shown}
		</span>
	);
};

/** Make a scratch note a note, where that is offered: only once it is stored. */
const moveOf = (scratch: ScratchScreen, note: NoteRecord): (() => void) | undefined => {
	const { onMove, onDelete } = scratch;
	if (onMove === undefined || onDelete === undefined) return undefined;
	return () => {
		onMove(note);
	};
};

/** A scratch note's own bar: its colour, its `⋯` and Close. */
const barOf = (scratch: ScratchScreen | undefined, note: NoteRecord): ReactNode =>
	scratch === undefined ? undefined : (
		<ScratchBar
			name={titleShown(note.title)}
			color={scratch.marks.color}
			onColor={(color) => {
				scratch.onMark({ color });
			}}
			onMove={moveOf(scratch, note)}
			onDelete={scratch.onDelete}
			onClose={scratch.onClose}
		/>
	);

/**
 * The note's own controls at the end of its header: where it is, the format
 * toggle in a compact window, the editor tabs, the outline.
 */
const NoteActions = ({
	note,
	mode,
	lost,
	retryable,
	toggleMode,
	layout,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	lost: StructuralDifference | undefined;
	retryable: boolean;
	toggleMode: () => void;
	layout: NoteLayout;
}) => {
	// Whether there is an outline to open. A button for a rail that would be
	// empty is a button that does nothing when pressed.
	const outlined = useMemo(() => headings(note.body).length > 0, [note.body]);
	return (
		<div className="note-actions">
			<NotePath path={note.path} />
			{layout.compact && mode === 'rich' && (
				<button
					type="button"
					className="note-icon"
					onClick={layout.toggleToolbar}
					aria-label={t('notes.view.format')}
					aria-pressed={layout.toolbar === 'bottom'}
					title={
						layout.toolbar === 'bottom'
							? t('notes.view.hideToolbar')
							: t('notes.view.showToolbar')
					}
				>
					<Icon name="format" />
				</button>
			)}
			{mode !== undefined && (
				<ModeTabs
					mode={mode}
					locked={lost !== undefined}
					retryable={retryable}
					toggleMode={toggleMode}
				/>
			)}
			{/* At the right-hand edge: the rail it opens is the note's, and
			    is drawn there. */}
			{outlined && (
				<button
					type="button"
					className="note-icon"
					onClick={layout.toggleOutline}
					aria-label={t('notes.view.outline')}
					aria-pressed={layout.showOutline}
					// Pressing it while the flyout is open closes it, so a
					// press outside the flyout that lands here is not one.
					data-outline-toggle=""
					title={
						layout.showOutline
							? t('notes.view.hideOutline')
							: t('notes.view.showOutline')
					}
				>
					<Icon name="outline" />
				</button>
			)}
		</div>
	);
};

/**
 * Everything below the provider.
 *
 * Split out because the bar and the editors have to be inside the same
 * `FindTargetProvider`: the editor offers itself to it and the bar reads it.
 */
export const NoteScreen = ({
	note,
	mode,
	lost,
	retryable,
	unsaved,
	finding,
	layout,
	onBody,
	toggleMode,
	onClose,
	begun,
	draft,
	onRename,
	onTitleDone,
	onUserEdit,
	onUnsupported,
	onAdopted,
	onAdded,
	scratch,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	/** What the rich editor could not show, while the note is held in raw mode. */
	lost: StructuralDifference | undefined;
	/** The note has changed since, and the rich editor may be asked again. */
	retryable: boolean;
	/** A save was rejected, and what it held is still only in this tab. */
	unsaved: boolean;
	finding: number;
	layout: NoteLayout;
	onBody: (element: HTMLDivElement | null) => void;
	toggleMode: () => void;
	onClose: () => void;
	/** A draft: begun just now, stored nowhere yet (`NoteViewProps.draft`). */
	begun: boolean;
	draft: NoteDraft | undefined;
	onRename: (title: string) => void;
	onTitleDone: () => void;
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: (lost: StructuralDifference) => void;
	onAdopted: () => void;
	onAdded: (path: string) => void;
	/** A scratch note's editor, and what it is marked with. */
	scratch: ScratchScreen | undefined;
}) => (
	<section
		className={scratch === undefined ? 'note-view' : 'note-view scratch-editor'}
		aria-label={t('notes.view.label')}
		data-color={scratch?.marks.color}
	>
		<header className="note-header">
			<TitleField
				key={noteRef(note)}
				note={note}
				// A scratch note's caret goes to its body (`ScratchEditing`).
				startFocused={begun && scratch === undefined}
				onRename={onRename}
				onDone={onTitleDone}
				blankWhenUnnamed={scratch !== undefined}
			/>
			{scratch === undefined ? (
				<NoteActions
					note={note}
					mode={mode}
					lost={lost}
					retryable={retryable}
					toggleMode={toggleMode}
					layout={layout}
				/>
			) : (
				<div className="note-actions">
					{lost !== undefined && mode !== undefined && (
						<ModeTabs
							mode={mode}
							locked
							retryable={retryable}
							toggleMode={toggleMode}
						/>
					)}
					<PinButton
						pinned={scratch.marks.pinned}
						onToggle={() => {
							scratch.onMark({ pinned: scratch.marks.pinned ? undefined : true });
						}}
					/>
				</div>
			)}
		</header>

		{/*
		 * An alert, and it stays for as long as it is true. It does not say "this
		 * note": a held edit may be to the note that was open before this one.
		 * Nor what went wrong, which the app cannot tell — only what is safe to
		 * do about it.
		 */}
		{unsaved && (
			<p className="banner banner-alert" role="alert">
				{t('notes.view.unsaved')}
			</p>
		)}

		{lost !== undefined && <UnsupportedBanner lost={lost} retryable={retryable} />}

		{/*
		 * A rename or a tag edit cannot reach a file whose frontmatter has a
		 * YAML error in it: the app will not rewrite a block it had to guess
		 * at, so the change lands in the app and not in the file, and the next
		 * sync reads the old values back over it. Saying so is the difference
		 * between a limitation and a note that quietly refuses to be renamed.
		 */}
		{/*
		 * `role="note"`, not `status`: this is true of the note from the moment
		 * it opens, so it is a standing remark rather than something that has
		 * just happened — and two live regions announcing at once is one too
		 * many when a note is also in the rich editor's unsupported state.
		 */}
		{!frontmatterIsEditable(note.frontmatter) && (
			<p className="banner" role="note">
				{t('notes.view.yamlError')}
			</p>
		)}

		{finding > 0 && <FindBar focusToken={finding} onClose={onClose} />}

		<NoteBody
			note={note}
			mode={mode}
			showOutline={scratch === undefined && layout.showOutline}
			flyout={layout.flyout}
			focusEditor={!layout.touch}
			onCloseOutline={layout.closeOutline}
			// Always shown, at the foot: a scratch note's bar is short enough
			// for a phone, and its only way to a list.
			toolbar={scratch === undefined ? layout.toolbar : 'bottom'}
			onUserEdit={onUserEdit}
			draft={draft}
			onUnsupported={onUnsupported}
			onAdopted={onAdopted}
			onBody={onBody}
			onAdded={onAdded}
			basic={scratch !== undefined}
			// On the toolbar's row; under the note in Markdown, which has none.
			toolbarEnd={mode === 'rich' ? barOf(scratch, note) : undefined}
		/>
		{mode !== 'rich' && barOf(scratch, note)}
	</section>
);
