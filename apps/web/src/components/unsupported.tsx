import type { StructuralDifference } from '@skysa/core';
import { type ReactNode, useCallback, useState } from 'react';

import { db, type NoteRecord, noteRef } from '../store/db.js';
import { getNote, setNoteEditorMode } from '../store/notes.js';

/**
 * A note the rich editor said it would damage, and the way back out.
 *
 * The rich editor checks every note before the user can type into it and
 * reports the first thing its document would drop (`whatIsLost`, §7). The note
 * is then held in raw mode — and until this existed, held there for as long as
 * it stayed open, whatever the user did about it. Now the lock lifts on the
 * user's own say-so: once the body is no longer the one that failed, the rich
 * tab is offered again, and pressing it mounts the rich editor, whose own check
 * runs again before anything can be typed. A note that still fails comes
 * straight back here, untouched, with the banner saying what it found this
 * time. Typing never lifts it by itself: the editor must not change under the
 * user mid-sentence.
 */

interface Held {
	/** `noteRef` of the note, so another note — or another source's — is not held. */
	readonly ref: string;
	/** The body that failed. Once the note's body is not this, it is worth trying again. */
	readonly body: string;
	readonly lost: StructuralDifference;
	/** Typed into since: the body has changed even if the store has not heard yet. */
	readonly edited: boolean;
	/**
	 * A retry, waiting for the body it read back from the store to be the one on
	 * screen — so that the rich editor is built from what the user just wrote
	 * rather than from the version before it.
	 */
	readonly retryWhen?: string;
}

export interface Unsupported {
	/** What the editor could not show, while the note is held in raw mode. */
	lost: StructuralDifference | undefined;
	/** The rich tab may be pressed: the body has changed since it failed. */
	retryable: boolean;
	/** The rich editor's report. */
	report: (lost: StructuralDifference) => void;
	/** The raw editor's edit, which is what makes a retry worth offering. */
	edited: () => void;
	/** The rich tab, pressed. */
	retry: () => void;
}

export const useUnsupported = (
	note: NoteRecord | undefined,
	{
		rebased,
		settle,
		failing,
	}: {
		/** Autosave's: the editor is about to be rebuilt from the stored body. */
		rebased: () => void;
		/** Autosave's: everything typed is written, or has been tried. */
		settle: () => Promise<unknown>;
		/** A save was refused. What is on screen is then not what is stored. */
		failing: boolean;
	}
): Unsupported => {
	const [held, setHeld] = useState<Held | null>(null);
	const ref = note === undefined ? undefined : noteRef(note);
	const body = note?.body;
	const mine = held !== null && held.ref === ref ? held : undefined;

	// A retry's body has reached the screen: the lock lifts, and the rich editor
	// is built from it. Adjusted during render rather than in an effect, as React
	// has it for state that follows a prop, so no frame is drawn with the lock
	// still on and the new body under it.
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
	const lifted = mine?.retryWhen !== undefined && mine.retryWhen === body;
	if (lifted) setHeld(null);
	const current = lifted ? undefined : mine;

	const report = useCallback(
		(lost: StructuralDifference) => {
			if (note === undefined) return;
			// The raw editor takes over, built from the stored body.
			rebased();
			setHeld({ ref: noteRef(note), body: note.body, lost, edited: false });
		},
		[note, rebased]
	);

	const edited = useCallback(() => {
		// The same object back when there is nothing to change, so a keystroke
		// in a note nobody is holding does not render anything.
		setHeld((was) =>
			was !== null && was.ref === ref && !was.edited ? { ...was, edited: true } : was
		);
	}, [ref]);

	const retryable =
		current !== undefined && !failing && (current.edited || current.body !== body);

	const retry = useCallback(() => {
		if (note === undefined || !retryable) return;
		const at = noteRef(note);
		const scope = { connectionId: note.connectionId };
		// Everything typed goes in first, as for any switch of mode; then the
		// body the rich editor will be built from is read back, and the lock
		// lifts only once that is the body on screen.
		rebased();
		void settle()
			.then(() => setNoteEditorMode(db, note.id, 'rich', scope))
			.then(() => getNote(db, note.id, scope))
			.then((row) => {
				if (row === undefined) return;
				setHeld((was) => (was?.ref === at ? { ...was, retryWhen: row.body } : was));
			});
	}, [note, rebased, retryable, settle]);

	return { lost: current?.lost, retryable, report, edited, retry };
};

/**
 * The words for what the editor could not show, by mdast type. Only what a
 * banner can usefully point at: anything else is described as "markdown", as
 * the banner always used to.
 */
const NAMES: Record<string, string> = {
	blockquote: 'a quote',
	break: 'a line break',
	code: 'a code block',
	definition: 'a link reference definition',
	delete: 'strikethrough',
	emphasis: 'emphasis',
	footnoteDefinition: 'a footnote',
	footnoteReference: 'a footnote reference',
	heading: 'a heading',
	image: 'an image',
	imageReference: 'a reference-style image',
	inlineCode: 'inline code',
	link: 'a link',
	linkReference: 'a reference-style link',
	list: 'a list',
	listItem: 'a list item',
	strong: 'bold text',
	table: 'a table',
	thematicBreak: 'a divider',
};

const what = (lost: StructuralDifference): ReactNode => {
	if (lost.type === 'html') {
		return lost.value === undefined ? (
			'some HTML'
		) : (
			<>
				the HTML <code>{lost.value}</code>
			</>
		);
	}
	return NAMES[lost.type];
};

export const UnsupportedBanner = ({
	lost,
	retryable,
}: {
	lost: StructuralDifference;
	retryable: boolean;
}) => {
	const named = what(lost);
	const where = lost.line === undefined ? '' : ` on line ${String(lost.line)}`;
	return (
		<p className="banner" role="status">
			{named === undefined ? (
				'This note uses markdown the rich editor has no way to show'
			) : (
				<>
					The rich editor has no way to show {named}
					{where}
				</>
			)}
			, so this note stays in markdown mode. Nothing in it has been changed.{' '}
			{retryable
				? 'Switch to rich text to try again.'
				: 'Change it here, then switch to rich text to try again.'}
		</p>
	);
};
