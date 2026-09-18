import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';

import { editorViewCtx } from '@milkdown/kit/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { ProsemirrorAdapterProvider, usePluginViewFactory } from '@prosemirror-adapter/react';
import { useEffect, useRef } from 'react';

import { richFindTarget } from './findRich.js';
import { useOfferFindTarget } from './findTarget.js';
import { useIncomingBody } from './incoming.js';
import { InlineToolbar } from './InlineToolbar.js';
import { adoptBody, createRichEditor, representsFaithfully } from './rich.js';
import { SlashMenu } from './SlashMenu.js';

/**
 * Rich text mode. The editor lives in `rich.ts`; this is the React side of it —
 * when to build one, what to feed it, and what to do when it reports back.
 */

export interface RichEditorProps {
	/** Identity of the note being edited. Changing it reloads the document. */
	noteId: string;
	/** Markdown body, frontmatter already stripped. */
	body: string;
	/** The note's `bodyOrigin`. */
	origin?: string;
	/** The edited body, and the origin of the body it was typed into. */
	onUserEdit: (body: string, origin: string) => void;
	/**
	 * Called when this note cannot survive the editor's document model — some
	 * construct in it would be dropped the moment the user typed. The note
	 * belongs in raw mode instead.
	 */
	onUnsupported: () => void;
	/**
	 * The editor's text has been replaced by a body from outside — a sync pull,
	 * another tab. What was typed before is no longer under what is typed next.
	 */
	onAdopted?: () => void;
}

const EditorBody = ({
	noteId,
	body,
	origin,
	onUserEdit,
	onUnsupported,
	onAdopted,
}: RichEditorProps) => {
	// Read inside callbacks, so changing them does not rebuild the editor.
	const notify = useRef(onUserEdit);
	useEffect(() => {
		notify.current = onUserEdit;
	}, [onUserEdit]);

	const unsupported = useRef(onUnsupported);
	useEffect(() => {
		unsupported.current = onUnsupported;
	}, [onUnsupported]);

	const replaced = useRef(onAdopted);
	useEffect(() => {
		replaced.current = onAdopted;
	}, [onAdopted]);

	const incoming = useIncomingBody(noteId, body, origin);
	const pluginView = usePluginViewFactory();

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
					notify.current(markdown, incoming.base());
				},
				menus: {
					slash: { view: pluginView({ component: SlashMenu }) },
					tooltip: { view: pluginView({ component: InlineToolbar }) },
				},
			}),
		[noteId]
	);

	// The find bar acts on whichever editor is open, and this is the one that
	// knows when there is one. Built once per editor for the same reason the
	// fidelity check is: `get` is a fresh closure every render.
	const offer = useOfferFindTarget();
	useEffect(() => {
		if (loading) return;
		return get()?.action((ctx) => offer(richFindTarget(ctx.get(editorViewCtx))));
		// `get` is intentionally absent; see below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loading, noteId, offer]);

	// Can this note be shown at all? Checked once the editor exists, because only
	// then do its parser and serializer exist. This runs before the user has any
	// way to type, so a failing note reaches raw mode untouched.
	//
	// Once per editor, and deliberately not on `get`. `useEditor` returns a fresh
	// `get` closure on every render, so an effect that depends on it re-runs on
	// every render of this component — including the one autosave causes two
	// seconds after the user starts typing. It would then compare the document
	// the user has been writing in against `initial.current`, which is the text
	// the editor was *built* with, find they differ, and declare the note
	// unrepresentable. Typing one word into any note was enough.
	useEffect(() => {
		if (loading) return;
		get()?.action((ctx) => {
			if (representsFaithfully(ctx, initial.current)) return;
			unsupported.current();
		});
		// `get` is intentionally absent; see above.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loading, noteId]);

	// Adopt a body that changed underneath us — a sync pull, or an edit made in
	// raw mode. `shouldAdopt` is what keeps a stale prop on an unrelated re-render
	// from wiping out what the user has typed since the last save.
	useEffect(() => {
		if (loading) return;
		const editor = get();
		if (editor === undefined) return;
		if (!incoming.shouldAdopt(body)) return;
		editor.action((ctx) => {
			// Only a body the editor now holds moves what its edits are made
			// against: one it could not take in is asked about again.
			if (adoptBody(ctx, body)) {
				incoming.adopted();
				replaced.current?.();
			}
			// The same question the editor was built with, asked again of a body
			// that arrived from somewhere else. A sync pull can bring in markdown
			// this editor cannot show, and since the check above runs once, this
			// is the only place left to notice.
			if (!representsFaithfully(ctx, body)) unsupported.current();
		});
	}, [body, origin, get, incoming, loading]);

	return <Milkdown />;
};

/**
 * Keyed by note, so moving to another note builds a new editor rather than
 * re-pointing the old one.
 *
 * `useEditor` already asks for a rebuild on `noteId`, but it does not get one
 * synchronously: Milkdown tears the old editor down and awaits `create()`
 * inside the provider, so for at least one render after the note changes
 * `get()` still hands back the *previous* note's editor while the props and
 * refs around it describe the new one. Everything downstream — the fidelity
 * check, `adoptBody`, the incoming-body bookkeeping — then reasons about one
 * note's document using another note's text. The fidelity check is where it
 * showed: an ordinary click from one note to the next compared two unrelated
 * documents, decided they disagreed, and locked the destination note out of
 * rich text for the session under a banner claiming its markdown could not be
 * shown.
 *
 * A key is the blunt fix and the right one. The document is genuinely
 * different, so there is nothing in the old editor worth keeping — no cursor,
 * no undo history that belongs to this note — and remounting makes the stale
 * window impossible rather than merely narrow.
 */
export const RichEditor = (props: RichEditorProps) => (
	<div className="editor editor-rich" data-testid="rich-editor">
		<MilkdownProvider key={props.noteId}>
			<ProsemirrorAdapterProvider>
				<EditorBody {...props} />
			</ProsemirrorAdapterProvider>
		</MilkdownProvider>
	</div>
);
