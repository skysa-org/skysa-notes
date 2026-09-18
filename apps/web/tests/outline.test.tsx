import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Outline } from '../src/components/Outline.js';

/**
 * The rail itself. Where a click *lands* is the half jsdom cannot answer — a
 * CodeMirror view needs layout to scroll and ProseMirror needs a real editor —
 * so that is checked in a browser instead (docs/PLAN.md §7). What is checked
 * here is what the rail shows, and that a click reaches the right heading.
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
		const { container } = render(<Outline body="just words\n" editor={() => null} />);

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

	/**
	 * The rich-mode half of `jump`, which is the one jsdom can reach: a top-level
	 * heading is a direct child of `.ProseMirror`, so the nth such child is the
	 * nth heading `headings` found. Nothing else about the two orders is agreed,
	 * which is why both are top-level only.
	 */
	it('scrolls to the nth top-level heading of a rich editor', async () => {
		const user = userEvent.setup();
		const editor = document.createElement('div');
		editor.innerHTML =
			'<div class="ProseMirror"><h1>Top</h1><p>words</p>' +
			'<blockquote><h2>Quoted</h2></blockquote>' +
			'<h2>Middle</h2><h3>Deep</h3></div>';
		const scrolled: string[] = [];
		editor.querySelectorAll('h1, h2, h3').forEach((heading) => {
			vi.spyOn(heading, 'scrollIntoView').mockImplementation(() => {
				scrolled.push(heading.textContent);
			});
		});
		render(<Outline body={BODY} editor={() => editor} />);

		await user.click(screen.getByRole('button', { name: 'Middle' }));

		// Not "Quoted": it is inside a blockquote, so it is neither a row in the
		// rail nor a child of `.ProseMirror`, and the counting stays in step.
		expect(scrolled).toEqual(['Middle']);
	});

	it('does nothing when there is no editor to jump into', async () => {
		const user = userEvent.setup();
		render(<Outline body={BODY} editor={() => null} />);

		await expect(
			user.click(screen.getByRole('button', { name: 'Top' }))
		).resolves.toBeUndefined();
	});
});
