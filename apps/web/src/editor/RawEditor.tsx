import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { isUserEdit, programmatic } from './dirty.js';
import { findExtension, rawFindTarget } from './findRaw.js';
import { useOfferFindTarget } from './findTarget.js';
import { useIncomingBody } from './incoming.js';

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
}

export const RawEditor = ({ noteId, body, origin, onUserEdit }: RawEditorProps) => {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView>(null);
	// Read inside the update listener, so changing the callback does not tear
	// down and rebuild the editor.
	const notify = useRef(onUserEdit);
	useEffect(() => {
		notify.current = onUserEdit;
	}, [onUserEdit]);
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
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					markdown(),
					findExtension(),
					EditorView.lineWrapping,
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

	// Adopt a body that changed underneath us — a sync pull, or an edit made in
	// the other mode. Annotated as programmatic so it cannot mark the note dirty.
	useEffect(() => {
		const instance = view.current;
		if (instance === null) return;
		if (!incoming.shouldAdopt(body)) return;

		const current = instance.state.doc.toString();
		if (current !== body) {
			instance.dispatch({
				changes: { from: 0, to: current.length, insert: body },
				...programmatic,
			});
		}
		incoming.adopted();
	}, [body, origin, incoming]);

	return <div className="editor editor-raw" ref={host} data-testid="raw-editor" />;
};
