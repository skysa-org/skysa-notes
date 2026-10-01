import { useCallback, useSyncExternalStore } from 'react';

import { type NoteRecord, noteRef } from './db.js';
import { titleAfterEdit } from './notes.js';

/**
 * What the user is typing into a note before autosave has stored it, so that
 * everything else on screen showing the note — its row in the list, its name —
 * says what the editor says as it is typed, and not two seconds later
 * (`AUTOSAVE_DELAY_MS`) when the row catches up.
 *
 * Laid over a row for display and never written anywhere: the note is the
 * markdown string in the store (§7), and this is what it is about to be. Each
 * piece is let go of by the row overtaking it rather than by being cleared —
 * cleared when the write resolves, the row would show what it held before for
 * the moment the live query takes to bring it back, and the list would flicker
 * the old text into the gap.
 *
 * A store rather than React state, and the same shape as
 * `editor/codeDisplay.ts`, so that a keystroke redraws the one row and the
 * name field that show it, not every pane in the app.
 */

/** Text typed and not yet in the row, and when the row took it, if it has. */
interface Typed {
	readonly text: string;
	/**
	 * The `updatedAt` of the row the text was stored in. A row at least as new
	 * is the store's answer, and it wins: the text as stored (`saveNoteBody`
	 * drops a NUL), or a later edit from another tab on this device.
	 */
	readonly landed?: number;
}

interface TypedBody extends Typed {
	readonly origin: string;
}

export interface LiveEdit {
	/** The body as typed, into the body whose `bodyOrigin` this names. */
	readonly body?: TypedBody;
	/** A name being typed into the name field, before it is given. */
	readonly title?: Typed;
}

export interface LiveEdits {
	get: (ref: string) => LiveEdit | undefined;
	/** Listen to one note's edits, by `noteRef`. */
	subscribe: (ref: string, listener: () => void) => () => void;
	/** The body has been typed into. */
	typed: (ref: string, text: string, origin: string) => void;
	/** A name is being typed; `undefined` when it has been given up. */
	naming: (ref: string, text: string | undefined) => void;
	/**
	 * `text` was stored in a row as of `at`, or was not stored at all
	 * (`undefined`) and the row is what there is to show. About the text the
	 * write carried, which may since have been typed past.
	 */
	landed: (ref: string, field: 'body' | 'title', text: string, at: number | undefined) => void;
}

/**
 * How many notes are held. Each is let go of by its row rather than here, so
 * a long session would otherwise keep a body for every note typed into. A
 * note's entry pushed out shows its row, which is what is stored.
 */
const LIMIT = 50;

export const createLiveEdits = (): LiveEdits => {
	const held = new Map<string, LiveEdit>();
	const listeners = new Map<string, Set<() => void>>();

	const tell = (ref: string) => {
		listeners.get(ref)?.forEach((listener) => {
			listener();
		});
	};

	const put = (ref: string, edit: LiveEdit) => {
		// To the back, as the newest.
		held.delete(ref);
		if (edit.body !== undefined || edit.title !== undefined) held.set(ref, edit);
		tell(ref);
		if (held.size <= LIMIT) return;
		const [oldest] = held.keys();
		if (oldest === undefined) return;
		held.delete(oldest);
		tell(oldest);
	};

	return {
		get: (ref) => held.get(ref),
		subscribe: (ref, listener) => {
			const set = listeners.get(ref) ?? new Set();
			listeners.set(ref, set.add(listener));
			return () => {
				set.delete(listener);
				if (set.size === 0) listeners.delete(ref);
			};
		},
		typed: (ref, text, origin) => {
			put(ref, { ...held.get(ref), body: { text, origin } });
		},
		naming: (ref, text) => {
			const { title: _was, ...rest } = held.get(ref) ?? {};
			put(ref, text === undefined ? rest : { ...rest, title: { text } });
		},
		landed: (ref, field, text, at) => {
			const edit = held.get(ref);
			const typed = edit?.[field];
			// Typed past since this write was issued: what is held is newer, and
			// still not stored.
			if (edit === undefined || typed?.text !== text) return;
			const { [field]: _was, ...rest } = edit;
			put(ref, at === undefined ? rest : { ...rest, [field]: { ...typed, landed: at } });
		},
	};
};

const ahead = (typed: Typed | undefined, row: NoteRecord): typed is Typed =>
	typed !== undefined && (typed.landed === undefined || row.updatedAt < typed.landed);

/**
 * The title a body typed into a note gives it, by `titleAfterEdit`, which
 * `saveNoteBody` names it by — so the row cannot say one thing as it is typed
 * and another once it is stored. Asked once per body: the list's row and the
 * name field both ask it, and it is a parse.
 */
const derived = new WeakMap<object, { row: NoteRecord; title: string }>();

const titleOf = (row: NoteRecord, body: TypedBody): string => {
	const known = derived.get(body);
	if (
		known !== undefined &&
		known.row.path === row.path &&
		known.row.title === row.title &&
		known.row.frontmatter === row.frontmatter
	) {
		return known.title;
	}
	const title = titleAfterEdit(row, body.text);
	derived.set(body, { row, title });
	return title;
};

/**
 * A row as the user is seeing it: with the body they have typed, and the name
 * they are typing or the one their typing gives it — while the row is behind
 * them, and only then.
 *
 * A body counts only while it was typed into the body the row still holds
 * (`bodyOrigin`): one pulled from elsewhere since replaced what it was typed
 * into, and is not hidden under it. A name being typed counts once there is
 * something in it, since an empty name is never given. Shown not yet synced,
 * because it is not.
 */
export const shownNote = (row: NoteRecord, edit: LiveEdit | undefined): NoteRecord => {
	const body =
		ahead(edit?.body, row) && edit.body.origin === (row.bodyOrigin ?? '')
			? edit.body
			: undefined;
	const naming = ahead(edit?.title, row) ? edit.title.text.trim() : '';
	if (body === undefined && naming === '') return row;
	const title = naming === '' && body !== undefined ? titleOf(row, body) : naming;
	return {
		...row,
		title,
		...(body === undefined ? {} : { body: body.text, dirty: 1 }),
	};
};

/** One note's edits as they are typed, or `undefined` with no store to read. */
export const useLiveEdit = (
	edits: LiveEdits | undefined,
	note: NoteRecord | undefined
): LiveEdit | undefined => {
	const ref = note === undefined ? undefined : noteRef(note);
	const subscribe = useCallback(
		(listener: () => void) =>
			edits === undefined || ref === undefined
				? () => undefined
				: edits.subscribe(ref, listener),
		[edits, ref]
	);
	return useSyncExternalStore(subscribe, () =>
		edits === undefined || ref === undefined ? undefined : edits.get(ref)
	);
};
