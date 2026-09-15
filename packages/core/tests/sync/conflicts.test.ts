import { describe, expect, it } from 'vitest';

import {
	frontmatterIsEditable,
	readFrontmatter,
	splitFrontmatter,
} from '../../src/markdown/frontmatter.js';
import {
	conflictContent,
	conflictFilename,
	conflictPath,
	conflictStamp,
} from '../../src/sync/conflicts.js';

/**
 * The names and contents of a conflict copy. Every rule here exists because
 * getting it wrong loses the copy — a name a provider refuses, a name that
 * collides with the copy made a second ago, or an id that makes the copy and
 * the original the same note.
 */

const AT = new Date('2026-09-15T14:32:10.500Z');

describe('conflictStamp', () => {
	it('is the minute, in a form a filename can hold', () => {
		expect(conflictStamp(AT)).toBe('2026-09-15T14-32');
	});

	it('has no colon in it', () => {
		// Illegal on Windows and rejected outright by several provider APIs, and
		// a copy the provider will not store is a lost edit.
		expect(conflictStamp(AT)).not.toContain(':');
	});

	it('is the same in every time zone', () => {
		// Two devices conflicting on one note should produce one name, not two
		// that look hours apart and unrelated.
		expect(conflictStamp(new Date('2026-09-15T14:32:10Z'))).toBe(
			conflictStamp(new Date('2026-09-15T16:32:10+02:00'))
		);
	});
});

describe('conflictFilename', () => {
	it('keeps the name it came from', () => {
		expect(conflictFilename('meeting-notes.md', AT)).toBe(
			'meeting-notes (conflict 2026-09-15T14-32).md'
		);
	});

	it('does not slug the name', () => {
		// The copy has to be recognisable as the note it came from, and sort
		// next to it. A slug would lowercase it and strip the parentheses that
		// say what it is.
		expect(conflictFilename('Q3 Review.md', AT)).toBe(
			'Q3 Review (conflict 2026-09-15T14-32).md'
		);
	});

	it('steps aside for a copy that is already there', () => {
		// Minute resolution is not unique enough on its own, and the second copy
		// overwriting the first would lose exactly what it was made to save.
		const taken = ['a (conflict 2026-09-15T14-32).md'];
		expect(conflictFilename('a.md', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-2.md');
	});

	it('keeps stepping aside', () => {
		const taken = ['a (conflict 2026-09-15T14-32).md', 'a (conflict 2026-09-15T14-32)-2.md'];
		expect(conflictFilename('a.md', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-3.md');
	});

	it('treats a name that differs only in case as taken', () => {
		// Drive, Dropbox and macOS all do, so a name that looks free here is not
		// free where it matters.
		const taken = ['A (CONFLICT 2026-09-15T14-32).md'];
		expect(conflictFilename('a.md', AT, taken)).toBe('a (conflict 2026-09-15T14-32)-2.md');
	});

	it('copes with a name that has no extension', () => {
		expect(conflictFilename('notes', AT)).toBe('notes (conflict 2026-09-15T14-32).md');
	});
});

describe('conflictPath', () => {
	it('puts the copy in the same folder as the note', () => {
		expect(conflictPath('Work/Meetings/a.md', AT)).toBe(
			'Work/Meetings/a (conflict 2026-09-15T14-32).md'
		);
	});

	it('handles a note at the root', () => {
		expect(conflictPath('a.md', AT)).toBe('a (conflict 2026-09-15T14-32).md');
	});
});

describe('conflictContent', () => {
	const original = [
		'---',
		'id: original-id',
		'title: Notes',
		'mood: hopeful',
		'---',
		'',
		'# Notes',
		'',
	].join('\n');

	it('gives the copy an identity of its own', () => {
		// Two files claiming one id is the state the whole identity scheme
		// exists to avoid: the pair would fight over the same note for ever.
		expect(conflictContent(original, 'fresh-id')).toContain('id: fresh-id');
		expect(conflictContent(original, 'fresh-id')).not.toContain('original-id');
	});

	it('keeps every other key, including ones we know nothing about', () => {
		const copy = conflictContent(original, 'fresh-id');
		expect(copy).toContain('mood: hopeful');
		expect(copy).toContain('title: Notes');
	});

	it('keeps the body byte for byte', () => {
		const body = '# Notes\n\nSomething the user wrote.\n';
		const copy = conflictContent(`---\nid: x\n---\n\n${body}`, 'fresh-id');
		expect(splitFrontmatter(copy).body).toContain(body);
	});

	it('gives a file with no frontmatter one, so the copy can be tracked', () => {
		const copy = conflictContent('# Just markdown\n', 'fresh-id');
		expect(copy).toContain('id: fresh-id');
		expect(copy).toContain('# Just markdown');
	});

	/**
	 * A block the YAML parser had to recover from is still frontmatter, and
	 * still carries the note's id — but it cannot be edited in place, because
	 * rewriting a guess would put words in the user's file. The copy therefore
	 * has to be given a block of its own, or it goes out claiming to be the very
	 * note it was copied from, which is the one outcome this function exists to
	 * prevent.
	 */
	describe('when the frontmatter is malformed', () => {
		const malformed = [
			'---',
			'id: original-id',
			'title: Notes',
			'title: Notes',
			'---',
			'',
			'# Notes',
			'',
		].join('\n');

		it('still gives the copy an identity of its own', () => {
			const copy = conflictContent(malformed, 'fresh-id');
			expect(readFrontmatter(splitFrontmatter(copy).frontmatter).id).toBe('fresh-id');
			expect(copy).not.toContain('original-id');
		});

		it('carries what the parser could read into the block it builds', () => {
			const copy = conflictContent(malformed, 'fresh-id');
			const block = splitFrontmatter(copy).frontmatter;

			// Not just present in the file: in a block that parses, which the one
			// it was copied from did not. Reading it back is the whole point —
			// a copy nobody can patch would have the same problem again.
			expect(block).not.toBe(malformed);
			expect(frontmatterIsEditable(block)).toBe(true);
			expect(readFrontmatter(block).title).toBe('Notes');
		});

		it('keeps the body, and only the frontmatter changes', () => {
			const copy = conflictContent(malformed, 'fresh-id');
			expect(splitFrontmatter(copy).body).toBe(splitFrontmatter(malformed).body);
		});
	});
});
