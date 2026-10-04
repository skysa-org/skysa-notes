import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type FileCleanupVisit, useFileCleanup } from '../src/components/useFileCleanup.js';
import { type NoteRecord, noteRef } from '../src/store/db.js';
import type { FileCleanup } from '../src/store/fileCleanup.js';

/**
 * What a visit to a note may have taken out of it, handed over as the note is
 * left (`components/useFileCleanup.ts`).
 */

const note = (id: string, body: string, connectionId = 'c1'): NoteRecord =>
	({
		connectionId,
		id,
		path: `Work/${id}.md`,
		title: id,
		body,
	}) as NoteRecord;

const cleanup = () => ({ opened: vi.fn(), left: vi.fn(), flush: vi.fn() }) satisfies FileCleanup;

const visiting = (first: NoteRecord, spy: FileCleanup) =>
	renderHook<FileCleanupVisit, { shown: NoteRecord | undefined }>(
		({ shown }) => useFileCleanup(shown, spy),
		{ initialProps: { shown: first } }
	);

describe('a visit to a note', () => {
	it('hands over what the note linked when opened and what was put in it, once edited and left', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png) and [Q3](../Q3.pdf)\n');
		const { result, rerender } = visiting(plan, spy);
		expect(spy.opened).toHaveBeenCalledWith(noteRef(plan));

		result.current.added('Work/pasted.png');
		result.current.edited('Nothing linked now.\n', '');
		rerender({ shown: note('other', '') });

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', [
			'Work/a.png',
			'Q3.pdf',
			'Work/pasted.png',
		]);
	});

	it('hands over nothing when nothing was edited', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png)\n');
		const { unmount } = visiting(plan, spy);

		unmount();

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', []);
	});

	it('is the same visit while the note changes under it, and a new one for another note', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png)\n');
		const { result, rerender } = visiting(plan, spy);

		// Saved, renamed: the same note.
		rerender({ shown: { ...plan, body: 'Text.\n', title: 'Renamed' } });
		expect(spy.left).not.toHaveBeenCalled();
		result.current.edited('Text.\n', '');

		const other = note('other', '![b](b.png)\n');
		rerender({ shown: other });
		// What the next visit edits is its own.
		result.current.edited('', '');
		rerender({ shown: undefined });

		expect(spy.left.mock.calls).toEqual([
			[noteRef(plan), 'c1', ['Work/a.png']],
			[noteRef(other), 'c1', ['Work/b.png']],
		]);
		expect(spy.opened.mock.calls).toEqual([[noteRef(plan)], [noteRef(other)]]);
	});

	it('ends when the note moves to another source', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png)\n');
		const { result, rerender } = visiting(plan, spy);
		result.current.edited('', '');

		rerender({ shown: { ...plan, connectionId: 'c2' } });

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', ['Work/a.png']);
	});

	it('hands over nothing the note still names as it is left', () => {
		// Found in review: an edit anywhere handed over every file the note linked,
		// and a note edited and then deleted lost them all once its delete was sent.
		const spy = cleanup();
		const plan = note('plan', '![a](a.png) and ![b](b.png)\n');
		const { result, unmount } = visiting(plan, spy);

		result.current.edited('![a](a.png#zoom) and more\n', '');
		unmount();

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', ['Work/b.png']);
	});

	it('reads the body a pull brought since the last edit as well', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png)\n');
		const { result, rerender, unmount } = visiting(plan, spy);

		result.current.edited('Text.\n', '');
		// Another device put the picture back.
		rerender({ shown: { ...plan, body: '![a](a.png)\n', bodyOrigin: 'pulled' } });
		unmount();

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', []);
	});

	it('reads the body as typed where the save has not caught up', () => {
		const spy = cleanup();
		const plan = note('plan', '![a](a.png)\n');
		const { result, unmount } = visiting(plan, spy);

		// Left before autosave: the stored body still has the picture.
		result.current.edited('Text.\n', '');
		unmount();

		expect(spy.left).toHaveBeenCalledWith(noteRef(plan), 'c1', ['Work/a.png']);
	});
});
