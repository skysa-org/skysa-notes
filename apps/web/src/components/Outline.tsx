import { EditorView } from '@codemirror/view';
import { type Heading, headings } from '@skysa/core';
import { useMemo } from 'react';

/**
 * The note's headings, down the side, as somewhere to jump to.
 *
 * Inside `.note-view` rather than beside it. `.app-shell` is a three-column
 * grid with exactly one child per column (`styles.css`, `routes/index.tsx`), so
 * a fourth child there takes the sidebar's column and pushes the note view into
 * an implicit second row. `.note-view` is a flex column and a rail costs it
 * nothing.
 *
 * Where a click lands is the only part that knows which editor is open, and it
 * is told which by the class the editor puts on its own root:
 *
 * - **Raw.** `EditorView.findFromDOM` hands back the CodeMirror instance from
 *   its own DOM, and `doc.line(n)` is why `headings` reports a line and not an
 *   offset. It cannot be done by finding the heading's element instead, because
 *   CodeMirror only renders the lines near the viewport — the heading being
 *   jumped to is usually the one that is not there yet.
 * - **Rich.** ProseMirror renders a top-level heading as a direct child of
 *   `.ProseMirror`, so the *n*th such child is the heading with `ordinal` *n*.
 *   There is no markdown-offset-to-ProseMirror-position bridge in this app, and
 *   an outline is not a good reason to build one.
 *
 * What makes that counting sound is not merely that both walks are top-level
 * only. It is that Milkdown builds its document from the same remark parse, one
 * top-level node per top-level mdast child, *and* that a note whose markdown the
 * schema cannot represent is sent to raw mode entirely (`representsFaithfully`,
 * `NoteView`). So `jumpRich` only ever runs on a body whose top level maps onto
 * ProseMirror's one for one. That assumption lives in another file: relaxing the
 * unsupported rule — showing such a note read-only in rich mode, say — would
 * break this quietly.
 *
 * One disagreement is inherent and left alone: the rail reads the *saved* body
 * and the editor holds the live one, so for the couple of seconds before an
 * autosave a heading just typed or deleted is in one and not the other, and the
 * rows after it point at their neighbours. It corrects itself, and the
 * alternative is handing this component a live document.
 *
 * The class is checked rather than simply trying `findFromDOM` first, which
 * would be the same thing today and quietly stop being it: Milkdown's code-block
 * component renders a fenced block as an embedded CodeMirror, so the moment one
 * is added a rich-mode click would find *that* view — a real editor, correctly
 * mounted, holding somebody's shell script — and put the cursor in it.
 *
 * Neither jump can dirty a note. The raw one dispatches a selection and a scroll
 * effect and no `changes`; the rich one moves the browser's own selection. Both
 * rules in `editor/dirty.ts` begin at `docChanged`.
 */

export interface OutlineProps {
	/** The note's markdown body. */
	body: string;
	/** The element holding whichever editor is open. */
	editor: () => Element | null;
}

/** A top-level heading, as ProseMirror renders one. */
const HEADING_CHILD =
	':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6';

const jumpRaw = (editor: Element, heading: Heading): void => {
	const view = EditorView.findFromDOM(editor as HTMLElement);
	if (view === null) return;

	// Clamped, because the body the outline was read from and the document in
	// the editor are the same string a moment apart, and a pull can land between
	// them.
	const line = view.state.doc.line(Math.min(heading.line, view.state.doc.lines));
	view.dispatch({
		selection: { anchor: line.from },
		effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
	});
	view.focus();
};

const jumpRich = (editor: Element, heading: Heading): void => {
	const prose = editor.querySelector<HTMLElement>('.ProseMirror');
	const target = prose?.querySelectorAll(HEADING_CHILD)[heading.ordinal];
	if (prose === null || target === undefined) return;

	target.scrollIntoView({ block: 'start' });

	// Put the caret in the heading, the way the raw jump does, so that a reader
	// who arrived by keyboard carries on reading with the arrow keys instead of
	// scrolling the rail. ProseMirror reads its selection back from the DOM, so
	// this is the whole of it — and a selection is not a document change, which
	// is what makes it safe to do to a note that is not being edited: both rules
	// in `editor/dirty.ts` begin at `docChanged`.
	//
	// Focus first, and the order is load-bearing. ProseMirror ignores a
	// selection that changes while its view is unfocused, but its DOM observer
	// still records it as the selection it last saw; the focus that followed
	// would then find its own state and the DOM in agreement about a caret it
	// never adopted, and put its own back. Focused first, the same change is
	// read, applied, and left alone.
	//
	// `preventScroll` because the line above has already scrolled, to the top of
	// the heading rather than to wherever the browser would put the caret.
	prose.focus({ preventScroll: true });
	const selection = window.getSelection();
	const range = document.createRange();
	range.setStart(target, 0);
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
};

const jump = (editor: Element | null, heading: Heading): void => {
	if (editor === null) return;
	if (editor.classList.contains('editor-raw')) jumpRaw(editor, heading);
	else jumpRich(editor, heading);
};

export const Outline = ({ body, editor }: OutlineProps) => {
	// Recomputed when the body changes, which is what it is a view of. This is a
	// parse (`packages/core/src/markdown/outline.ts`) rather than the pass over
	// the string a preview uses, so it is one note and not fifty.
	const found = useMemo(() => headings(body), [body]);

	if (found.length === 0) return null;

	return (
		<nav className="outline" aria-label="Outline">
			<ol>
				{found.map((heading) => (
					<li
						// Two headings can have the same text at the same depth,
						// so neither is the key: the line is what tells them
						// apart, and a line holds one heading.
						key={heading.line}
						className={`outline-h${String(heading.depth)}`}
					>
						<button
							type="button"
							onClick={() => {
								jump(editor(), heading);
							}}
						>
							{heading.text}
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
};
