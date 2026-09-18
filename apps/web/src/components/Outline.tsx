import { EditorView } from '@codemirror/view';
import { type Heading, headings } from '@skysa/core';
import { useState } from 'react';

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
 * asks the DOM rather than being told:
 *
 * - **Raw.** `EditorView.findFromDOM` hands back the CodeMirror instance from
 *   its own DOM, and `doc.line(n)` is why `headings` reports a line and not an
 *   offset. It cannot be done by finding the heading's element instead, because
 *   CodeMirror only renders the lines near the viewport — the heading being
 *   jumped to is usually the one that is not there yet.
 * - **Rich.** ProseMirror renders a top-level heading as a direct child of
 *   `.ProseMirror`, so the *n*th such child is the *n*th heading `headings`
 *   found — both are top-level-only, and that is the whole of the agreement
 *   between them. There is no markdown-offset-to-ProseMirror-position bridge in
 *   this app, and an outline is not a good reason to build one.
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

const jump = (editor: Element | null, heading: Heading, index: number): void => {
	if (editor === null) return;

	const raw = EditorView.findFromDOM(editor as HTMLElement);
	if (raw !== null) {
		// Clamped, because the body the outline was read from and the document
		// in the editor are the same string a moment apart, and a pull can land
		// between them.
		const line = raw.state.doc.line(Math.min(heading.line, raw.state.doc.lines));
		raw.dispatch({
			selection: { anchor: line.from },
			effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
		});
		raw.focus();
		return;
	}

	editor.querySelector('.ProseMirror')?.querySelectorAll(HEADING_CHILD)[index]?.scrollIntoView({
		block: 'start',
	});
};

export const Outline = ({ body, editor }: OutlineProps) => {
	// Recomputed when the body changes, which is what it is a view of. This is a
	// parse (`packages/core/src/markdown/outline.ts`) rather than the pass over
	// the string a preview uses, so it is one note and not fifty.
	const [cache, setCache] = useState<{ body: string; found: readonly Heading[] }>(() => ({
		body,
		found: headings(body),
	}));
	const found = cache.body === body ? cache.found : headings(body);
	if (cache.body !== body) setCache({ body, found });

	if (found.length === 0) return null;

	return (
		<nav className="outline" aria-label="Outline">
			<ol>
				{found.map((heading, index) => (
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
								jump(editor(), heading, index);
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
