import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Autolink } from '@lezer/markdown';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { useLatest } from '../hooks/useLatest.js';
import { rawCaretAboveKeyboard } from './aboveKeyboard.js';
import { type AttachmentHost, NO_ATTACHMENTS } from './attachHost.js';
import { isUserEdit, programmatic } from './dirty.js';
import { findExtension, rawFindTarget } from './findRaw.js';
import { useOfferFindTarget } from './findTarget.js';
import { CODE_HIGHLIGHTER } from './highlight.js';
import { useIncomingBody } from './incoming.js';
import { markdownCodeLanguages } from './languages.js';
import { rawLinks } from './linkRaw.js';
import { rawWithoutNul } from './noNul.js';
import { rawAttachments } from './rawAttach.js';
import { NO_SECRETS, type SecretHost } from './secretHost.js';
import { keepSecrets } from './secretPanels.js';
import { rawSecrets } from './secretRaw.js';

/**
 * Raw markdown mode: CodeMirror 6 over the note body. The body string is the
 * source of truth — this component holds no document model of its own, and
 * reports a change only when the user actually typed one.
 */

export interface RawEditorProps {
	/** Identity of the note being edited. Changing it reloads the document. */
	noteId: string;
	/** Markdown body, frontmatter already stripped. */
	body: string;
	/** The note's `bodyOrigin`. */
	origin?: string;
	/** The edited body, and the origin of the body it was typed into. */
	onUserEdit: (body: string, origin: string) => void;
	/**
	 * The editor's text has been replaced by a body from outside — a sync pull,
	 * another tab. What was typed before is no longer under what is typed next.
	 */
	onAdopted?: () => void;
	/**
	 * Where a file pasted or dropped into the note goes (`attachHost.ts`): the
	 * same host the rich editor is given. None, and a file is not taken.
	 */
	attachments?: AttachmentHost;
	/**
	 * How a secret in the note is opened and sealed (`secretHost.ts`): the
	 * same host the rich editor is given, read as the editor is made. None,
	 * and a secret is its armor and nothing more.
	 */
	secrets?: SecretHost;
}

/**
 * The undo history sits in a compartment so it can be emptied. CodeMirror has no
 * call for that; taking the extension out and putting it back is how its state
 * is thrown away.
 */
const undoHistory = new Compartment();

/**
 * How many characters `a` and `b` begin with alike, at most `most`: halved
 * and tried, each try one comparison of the engine's, so a long note costs
 * a few of them rather than one step a character.
 */
const alikeAtStart = (a: string, b: string, most: number, least = 0): number => {
	if (least >= most) return least;
	const half = Math.ceil((least + most) / 2);
	return a.slice(0, half) === b.slice(0, half)
		? alikeAtStart(a, b, most, half)
		: alikeAtStart(a, b, half - 1, least);
};

/** The same at the end. */
const alikeAtEnd = (a: string, b: string, most: number, least = 0): number => {
	if (least >= most) return least;
	const half = Math.ceil((least + most) / 2);
	return a.slice(a.length - half) === b.slice(b.length - half)
		? alikeAtEnd(a, b, most, half)
		: alikeAtEnd(a, b, half - 1, least);
};

/**
 * `current` made `next` by one change, from where they first differ to where
 * they last do. What is alike either side stays as it is: the cursor, and a
 * secret's panel open under a fence the change did not touch, which a change
 * of the whole text would draw again, taking the focus from what is typed in
 * it (docs/ARCHITECTURE.md §7).
 */
export const changeBetween = (
	current: string,
	next: string
): { from: number; to: number; insert: string } => {
	const start = alikeAtStart(current, next, Math.min(current.length, next.length));
	const end = alikeAtEnd(current, next, Math.min(current.length, next.length) - start);
	return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) };
};

export const RawEditor = ({
	noteId,
	body,
	origin,
	onUserEdit,
	onAdopted,
	attachments,
	secrets,
}: RawEditorProps) => {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView>(null);
	// Read inside the update listener, so changing the callback does not tear
	// down and rebuild the editor.
	const notify = useLatest(onUserEdit);
	const replaced = useLatest(onAdopted);
	const files = useLatest(attachments);
	const sealing = useLatest(secrets);
	const incoming = useIncomingBody(noteId, body, origin);
	// Offered from inside the effect that builds the editor, so the bar has one
	// exactly as long as there is an editor to act on.
	const offer = useOfferFindTarget();

	useEffect(() => {
		const parent = host.current;
		if (parent === null) return;

		const instance = new EditorView({
			parent,
			state: EditorState.create({
				doc: body,
				extensions: [
					lineNumbers(),
					undoHistory.of(history()),
					// Ahead of the default keymap, for Alt+Enter (`linkRaw.ts`).
					rawLinks(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					// The inside of a fence is another language, and raw mode
					// colours it with the same grammars and the same token
					// classes rich mode uses — one code block, one look, whichever
					// mode the note is open in. Markdown's own syntax is left in
					// black and white: raw mode is the mode where the characters
					// are the formatting, and `CODE_HIGHLIGHTER` deliberately
					// names no tag that `lang-markdown` emits.
					//
					// A bare `https://…` is a link, as remark-gfm reads it in rich
					// text (`linkRaw.ts`). GFM's autolinks alone: the rest of GFM
					// would also change what Enter does in a task list.
					markdown({ codeLanguages: markdownCodeLanguages(), extensions: [Autolink] }),
					syntaxHighlighting(CODE_HIGHLIGHTER),
					findExtension(),
					rawWithoutNul(),
					rawAttachments(() => files.current ?? NO_ATTACHMENTS),
					rawSecrets(() => sealing.current ?? NO_SECRETS),
					EditorView.lineWrapping,
					rawCaretAboveKeyboard(),
					EditorView.updateListener.of((update) => {
						if (!isUserEdit(update)) return;
						const edited = update.state.doc.toString();
						incoming.emit(edited);
						notify.current(edited, incoming.base());
					}),
				],
			}),
		});
		view.current = instance;
		const withdraw = offer(rawFindTarget(instance));

		return () => {
			withdraw();
			instance.destroy();
			view.current = null;
		};
		// Rebuilt only when the note changes: `body` is read once as the initial
		// document, and kept in step by the effect below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noteId]);

	// What is typed in a secret's panel kept before the editor goes: a word an
	// input method is still composing is not in the note until then. A layout
	// effect's cleanup, so it runs before any passive one: the note's autosave
	// flushes in its own as the note is left, and must find the edit there.
	useLayoutEffect(
		() => () => {
			if (view.current !== null) keepSecrets(view.current);
		},
		[noteId]
	);

	// Adopt a body that changed underneath us — a sync pull, or an edit made in
	// the other mode. Annotated as programmatic so it cannot mark the note dirty.
	//
	// And the history goes with the old text. Undo after a pull would otherwise
	// put that text back as a *user* edit made against the new body, and autosave
	// would push it — quietly reverting whatever someone else wrote. Keeping the
	// adoption out of the history is not enough on its own: the older entries
	// stay, and describe a document that is no longer on screen.
	useEffect(() => {
		const instance = view.current;
		if (instance === null) return;
		if (!incoming.shouldAdopt(body)) return;

		const current = instance.state.doc.toString();
		if (current !== body) {
			instance.dispatch({
				changes: changeBetween(current, body),
				effects: undoHistory.reconfigure([]),
				annotations: [programmatic.annotations, Transaction.addToHistory.of(false)],
			});
			instance.dispatch({ effects: undoHistory.reconfigure(history()) });
		}
		incoming.adopted();
		if (current !== body) replaced.current?.();
	}, [body, origin, incoming, replaced]);

	return <div className="editor editor-raw" ref={host} data-testid="raw-editor" />;
};
