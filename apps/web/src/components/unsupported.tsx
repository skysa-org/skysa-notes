import type { StructuralDifference } from '@skysa/core';
import { type ReactNode, useCallback, useState } from 'react';

import { rich } from '../i18n/rich.js';
import { t } from '../i18n/t.js';
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
 * The words for what the editor could not show, by mdast type. A type with no
 * words here is named as it is: a banner that names nothing gives the user,
 * and whoever they report it to, nothing to look for (2026-10-04).
 */
const NAMES: Record<string, string> = {
	blockquote: t('notes.unsupported.names.blockquote'),
	break: t('notes.unsupported.names.break'),
	code: t('notes.unsupported.names.code'),
	definition: t('notes.unsupported.names.definition'),
	delete: t('notes.unsupported.names.delete'),
	emphasis: t('notes.unsupported.names.emphasis'),
	footnoteDefinition: t('notes.unsupported.names.footnoteDefinition'),
	footnoteReference: t('notes.unsupported.names.footnoteReference'),
	heading: t('notes.unsupported.names.heading'),
	image: t('notes.unsupported.names.image'),
	imageReference: t('notes.unsupported.names.imageReference'),
	inlineCode: t('notes.unsupported.names.inlineCode'),
	link: t('notes.unsupported.names.link'),
	linkReference: t('notes.unsupported.names.linkReference'),
	list: t('notes.unsupported.names.list'),
	listItem: t('notes.unsupported.names.listItem'),
	paragraph: t('notes.unsupported.names.paragraph'),
	strong: t('notes.unsupported.names.strong'),
	table: t('notes.unsupported.names.table'),
	tableCell: t('notes.unsupported.names.tableCell'),
	tableRow: t('notes.unsupported.names.tableRow'),
	thematicBreak: t('notes.unsupported.names.thematicBreak'),
	toml: t('notes.unsupported.names.frontmatter'),
	yaml: t('notes.unsupported.names.frontmatter'),
};

/**
 * Text as a banner can show it: what cannot be seen — a control character, a
 * zero-width one, a space other than the plain one — written as its code
 * point, since what an editor added unseen is exactly what is being looked for.
 */
const seen = (text: string): string =>
	text.replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S ]/gu,
		(char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
	);

/** What the banner's `<code>` is drawn as. */
const CODE = { code: (words: string) => <code>{words}</code> };

const what = (lost: StructuralDifference): ReactNode => {
	// The note as a whole: nothing in it is the one thing to point at.
	if (lost.type === 'root') return undefined;
	if (lost.type === 'html') {
		return lost.value === undefined
			? t('notes.unsupported.what.someHtml')
			: rich('notes.unsupported.what.html', CODE, { value: lost.value });
	}
	if (lost.type === 'text') {
		return lost.value === undefined
			? t('notes.unsupported.what.someText')
			: rich('notes.unsupported.what.text', CODE, { value: seen(lost.value) });
	}
	const name = NAMES[lost.type];
	if (name === undefined) {
		return lost.value === undefined
			? rich('notes.unsupported.what.kind', CODE, { type: lost.type })
			: rich('notes.unsupported.what.kindWithValue', CODE, {
					type: lost.type,
					value: seen(lost.value),
				});
	}
	return lost.value === undefined
		? name
		: rich('notes.unsupported.what.named', CODE, { name, value: seen(lost.value) });
};

/**
 * Why the note stays in markdown, with what the rich editor could not show
 * named where the sentence has room for it (`<what></what>`), and on which
 * line where that is known.
 */
const whyItStays = (lost: StructuralDifference, named: ReactNode): ReactNode => {
	const tags = { what: () => named };
	if (lost.line === undefined) {
		return lost.added === true
			? rich('notes.unsupported.wouldAdd', tags)
			: rich('notes.unsupported.cannotShow', tags);
	}
	// A place in the file rather than an amount of anything, so as it is.
	const at = { line: String(lost.line) };
	return lost.added === true
		? rich('notes.unsupported.wouldAddOnLine', tags, at)
		: rich('notes.unsupported.cannotShowOnLine', tags, at);
};

export const UnsupportedBanner = ({
	lost,
	retryable,
}: {
	lost: StructuralDifference;
	retryable: boolean;
}) => {
	const named = what(lost);
	return (
		<p className="banner" role="status">
			{named === undefined ? t('notes.unsupported.whole') : whyItStays(lost, named)}{' '}
			{retryable ? t('notes.unsupported.retry') : t('notes.unsupported.changeFirst')}
		</p>
	);
};
