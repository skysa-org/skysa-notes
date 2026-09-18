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
 *   `.ProseMirror`, so the *n*th such child is the heading with `ordinal` *n* —
 *   both are top-level-only, and that is the whole of the agreement between
 *   them. There is no markdown-offset-to-ProseMirror-position bridge in this
 *   app, and an outline is not a good reason to build one.
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
	const prose = editor.querySelector('.ProseMirror');
	const target = prose?.querySelectorAll(HEADING_CHILD)[heading.ordinal];
	if (prose === null || target === undefined) return;

	target.scrollIntoView({ block: 'start' });

	// Put the caret in the heading, the way the raw jump does, so that a reader
	// who arrived by keyboard carries on reading with the arrow keys instead of
	// scrolling the rail. ProseMirror reads its selection back from the DOM, so
	// this is the whole of it — and a selection is not a document change, which
	// is what makes it safe to do to a note that is not being edited.
	const selection = window.getSelection();
	const range = document.createRange();
	range.setStart(target, 0);
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
	(prose as HTMLElement).focus({ preventScroll: true });
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
