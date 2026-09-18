import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { noteById } from './noteRows.js';

/**
 * What happens to a note the rich editor would damage.
 *
 * No real note does this today — every fixture survives both fidelity suites —
 * so the editor is stubbed to report the failure. The point of the test is that
 * when it ever does happen the user keeps their note: raw mode, an explanation,
 * and no way to toggle back into the editor that would eat it.
 */
vi.mock('../src/editor/RichEditor.js', () => ({
	RichEditor: ({ onUnsupported }: { onUnsupported: () => void }) => {
		useEffect(onUnsupported, [onUnsupported]);
		return <div data-testid="rich-editor" />;
	},
}));

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
});

describe('a note the rich editor cannot represent', () => {
	it('falls back to markdown, says why, and stays there', async () => {
		const user = userEvent.setup();
		const note = await createNote(db, { title: 'Exotic', body: 'something unrepresentable\n' });
		render(<Harness id={note.id} />);

		expect(await screen.findByTestId('raw-editor')).toBeDefined();
		expect(screen.getByRole('status').textContent).toContain('stays in markdown mode');

		const toggle = screen.getByRole('button', { name: 'Markdown' });
		expect(toggle.getAttribute('disabled')).not.toBeNull();

		await user.keyboard('{Control>}e{/Control}');

		expect(screen.getByTestId('raw-editor')).toBeDefined();
		expect(await noteById(db, note.id)).toMatchObject({ body: 'something unrepresentable\n' });
	});
});
