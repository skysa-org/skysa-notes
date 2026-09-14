import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';

import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { useEffect, useRef } from 'react';

import { useIncomingBody } from './incoming.js';
import { adoptBody, createRichEditor, representsFaithfully } from './rich.js';

/**
 * Rich text mode. The editor lives in `rich.ts`; this is the React side of it —
 * when to build one, what to feed it, and what to do when it reports back.
 */

export interface RichEditorProps {
	/** Identity of the note being edited. Changing it reloads the document. */
	noteId: string;
	/** Markdown body, frontmatter already stripped. */
	body: string;
	onUserEdit: (body: string) => void;
	/**
	 * Called when this note cannot survive the editor's document model — some
	 * construct in it would be dropped the moment the user typed. The note
	 * belongs in raw mode instead.
	 */
	onUnsupported: () => void;
}

const EditorBody = ({ noteId, body, onUserEdit, onUnsupported }: RichEditorProps) => {
	// Read inside callbacks, so changing them does not rebuild the editor.
	const notify = useRef(onUserEdit);
	useEffect(() => {
		notify.current = onUserEdit;
	}, [onUserEdit]);

	const unsupported = useRef(onUnsupported);
	useEffect(() => {
		unsupported.current = onUnsupported;
	}, [onUnsupported]);

	const incoming = useIncomingBody(noteId, body);

	// The body the editor was built with. Read once per note: the effect below
	// keeps a mounted editor in step, and rebuilding it on every keystroke would
	// throw away the cursor and the undo history.
	const initial = useRef(body);
	useEffect(() => {
		initial.current = body;
		// Only when the note changes; `body` is deliberately not a dependency.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noteId]);

	const { loading, get } = useEditor(
		(root) =>
			createRichEditor({
				root,
				body: initial.current,
				onUserEdit: (markdown) => {
					incoming.emit(markdown);
					notify.current(markdown);
				},
			}),
		[noteId]
	);

	// Can this note be shown at all? Checked once the editor exists, because only
	// then do its parser and serializer exist. This runs inside `create()`, before
	// the user has any way to type, so a failing note reaches raw mode untouched.
	useEffect(() => {
		if (loading) return;
		get()?.action((ctx) => {
			if (representsFaithfully(ctx, initial.current)) return;
			unsupported.current();
		});
	}, [loading, get, noteId]);

	// Adopt a body that changed underneath us — a sync pull, or an edit made in
	// raw mode. `shouldAdopt` is what keeps a stale prop on an unrelated re-render
	// from wiping out what the user has typed since the last save.
	useEffect(() => {
		if (loading) return;
		if (!incoming.shouldAdopt(body)) return;
		get()?.action((ctx) => {
			adoptBody(ctx, body);
		});
	}, [body, get, incoming, loading]);

	return <Milkdown />;
};

export const RichEditor = (props: RichEditorProps) => (
	<div className="editor editor-rich" data-testid="rich-editor">
		<MilkdownProvider>
			<EditorBody {...props} />
		</MilkdownProvider>
	</div>
);
