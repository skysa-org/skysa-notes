import { EditorView } from '@codemirror/view';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Outline } from '../src/components/Outline.js';
import { RawEditor } from '../src/editor/RawEditor.js';

/**
 * The rail, and where a click lands.
 *
 * The raw half is reachable here — jsdom carries CodeMirror as far as dispatch,
 * which is what `RawEditor.test.tsx` already relies on — so the two things that
 * matter most are pinned here: that a jump selects the line `headings` named,
 * and that it does not report an edit. What jsdom cannot answer is whether the
 * viewport actually moved, since scrolling needs layout, and the rich editor
 * cannot be typed into at all; both are checked in a browser instead
 * (docs/PLAN.md §7).
 */

afterEach(cleanup);

const BODY = ['# Top', '', 'words', '', '## Middle', '', 'more', '', '### Deep', ''].join('\n');

describe('the outline', () => {
	it('lists the note’s headings, in order, with their depth', () => {
		render(<Outline body={BODY} editor={() => null} />);

		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'Top',
			'Middle',
			'Deep',
		]);
		expect(screen.getByRole('button', { name: 'Deep' }).closest('li')?.className).toBe(
			'outline-h3'
		);
	});

	it('shows nothing at all for a note with no headings', () => {
		const { container } = render(<Outline body={'just words\n'} editor={() => null} />);

		expect(container.querySelector('.outline')).toBeNull();
	});

	/** Two sections can be called the same thing; the rail still has to list both. */
	it('keeps both of two headings with the same text', () => {
		render(<Outline body={'## Notes\n\na\n\n## Notes\n\nb\n'} editor={() => null} />);

		expect(screen.getAllByRole('button')).toHaveLength(2);
	});

	it('re-reads the headings when the body changes', () => {
		const { rerender } = render(<Outline body={'# One\n'} editor={() => null} />);
		rerender(<Outline body={'# One\n\n## Two\n'} editor={() => null} />);

		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			'One',
			'Two',
		]);
	});

	describe('jumping into the raw editor', () => {
		const rawEditor = (body: string) => {
			const onUserEdit = vi.fn();
			const view = render(
				<>
					<RawEditor noteId="a" body={body} origin={body} onUserEdit={onUserEdit} />
					<Outline body={body} editor={() => view.container.querySelector('.editor')} />
				</>
			);
			const editor = EditorView.findFromDOM(view.container);
			if (editor === null) throw new Error('CodeMirror did not mount');
			return { editor, onUserEdit };
		};

		it('puts the cursor at the start of the heading’s line', async () => {
			const user = userEvent.setup();
			const { editor } = rawEditor(BODY);

			await user.click(screen.getByRole('button', { name: 'Middle' }));

			// `## Middle` is line 5, which is the whole reason `headings` reports
			// a line: this is `doc.line(n)` with nothing in between.
			expect(editor.state.selection.main.head).toBe(editor.state.doc.line(5).from);
		});

		/**
		 * The hard rule (`editor/dirty.ts`, docs/PLAN.md §7): a note becomes dirty
		 * only on a user editing transaction. An outline reads a note; adding a
		 * `changes` to that dispatch would rewrite files the user only looked at.
		 */
		it('does not report an edit', async () => {
			const user = userEvent.setup();
			const { onUserEdit } = rawEditor(BODY);

			await user.click(screen.getByRole('button', { name: 'Deep' }));

			expect(onUserEdit).not.toHaveBeenCalled();
		});

		/**
		 * The body in the editor and the body the rail was read from are the same
		 * string a moment apart, and a sync can land between them.
		 */
		it('clamps to the last line when the document has shrunk underneath it', async () => {
			const user = userEvent.setup();
			const { editor } = rawEditor(BODY);
			editor.dispatch({
				changes: { from: 0, to: editor.state.doc.length, insert: '# Top\n' },
			});

			await user.click(screen.getByRole('button', { name: 'Deep' }));

			expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from);
		});
	});

	describe('jumping into the rich editor', () => {
		// `cleanup` only unmounts what React rendered, and these fixtures have to
		// be in the document: jsdom's `Selection.addRange` ignores a range whose
		// root is not.
		const mounted: Element[] = [];
		afterEach(() => {
			mounted.forEach((editor) => {
				editor.remove();
			});
			mounted.length = 0;
		});

		const richEditor = (html: string) => {
			const editor = document.createElement('div');
			editor.className = 'editor editor-rich';
			// `contenteditable` because focus is half of what a jump does and a
			// plain div cannot take it — without this, deleting the `focus` call
			// would fail nothing.
			editor.innerHTML = `<div class="ProseMirror" contenteditable="true">${html}</div>`;
			document.body.append(editor);
			mounted.push(editor);
			const scrolled: string[] = [];
			editor.querySelectorAll('h1, h2, h3').forEach((heading) => {
				vi.spyOn(heading, 'scrollIntoView').mockImplementation(() => {
					scrolled.push(heading.textContent);
				});
			});
			return { editor, scrolled };
		};

		/**
		 * A top-level heading is a direct child of `.ProseMirror`, so the nth such
		 * child is the heading with `ordinal` n. Nothing else about the two orders
		 * is agreed, which is why both walks are top-level only.
		 */
		it('scrolls to the nth top-level heading', async () => {
			const user = userEvent.setup();
			const { editor, scrolled } = richEditor(
				'<h1>Top</h1><p>words</p><blockquote><h2>Quoted</h2></blockquote>' +
					'<h2>Middle</h2><h3>Deep</h3>'
			);
			render(<Outline body={BODY} editor={() => editor} />);

			await user.click(screen.getByRole('button', { name: 'Middle' }));

			// Not "Quoted": it is inside a blockquote, so it is neither a row in
			// the rail nor a child of `.ProseMirror`, and the counting stays in
			// step.
			expect(scrolled).toEqual(['Middle']);
		});

		/**
		 * The rail drops a heading with no text; ProseMirror still draws it. So the
		 * rail's *third* row is the document's *fifth* heading, and matching by row
		 * position instead of `ordinal` sends every row after the first empty
		 * heading to its neighbour.
		 */
		it('counts the empty headings the rail does not show', async () => {
			const user = userEvent.setup();
			const { editor, scrolled } = richEditor(
				'<h1>One</h1><h2></h2><h2>Two</h2><h2><img alt="" src="x.png"></h2><h3>Three</h3>'
			);
			render(
				<Outline
					body={'# One\n\n##\n\n## Two\n\n## ![](x.png)\n\n### Three\n'}
					editor={() => editor}
				/>
			);

			await user.click(screen.getByRole('button', { name: 'Three' }));

			expect(scrolled).toEqual(['Three']);
		});

		/**
		 * The reason the open editor is identified by its class rather than by
		 * trying `EditorView.findFromDOM` first, which is the same thing today and
		 * quietly stops being it. Milkdown's code-block component renders a fenced
		 * block as an embedded CodeMirror, so `findFromDOM` on a *rich* editor
		 * holding one hands back a real view — and the jump would put the cursor
		 * in somebody's shell script instead of scrolling the note.
		 */
		it('does not mistake a code block’s editor for the raw one', async () => {
			const user = userEvent.setup();
			const { editor, scrolled } = richEditor('<h1>Top</h1><h2>Middle</h2><h3>Deep</h3>');
			const block = document.createElement('div');
			editor.querySelector('.ProseMirror')?.append(block);
			const embedded = new EditorView({ doc: 'a\nb\nc\nd\ne\nf\n', parent: block });
			render(<Outline body={BODY} editor={() => editor} />);

			await user.click(screen.getByRole('button', { name: 'Middle' }));

			expect(scrolled).toEqual(['Middle']);
			expect(embedded.state.selection.main.head).toBe(0);
			embedded.destroy();
		});

		it('focuses the editor and leaves the caret in the heading', async () => {
			const user = userEvent.setup();
			const { editor } = richEditor('<h1>Top</h1><h2>Middle</h2><h3>Deep</h3>');
			render(<Outline body={BODY} editor={() => editor} />);

			await user.click(screen.getByRole('button', { name: 'Deep' }));

			// Focus so that reading carries on by keyboard instead of the arrow
			// keys scrolling the rail; the caret so that it carries on from the
			// heading rather than from wherever it was.
			expect(document.activeElement).toBe(editor.querySelector('.ProseMirror'));
			const selection = window.getSelection();
			expect(selection?.anchorNode).toBe(screen.getByRole('heading', { name: 'Deep' }));
			expect(selection?.anchorOffset).toBe(0);
			expect(selection?.isCollapsed).toBe(true);
		});
	});

	it('does nothing when there is no editor to jump into', async () => {
		const user = userEvent.setup();
		render(<Outline body={BODY} editor={() => null} />);

		await expect(
			user.click(screen.getByRole('button', { name: 'Top' }))
		).resolves.toBeUndefined();
	});
});
