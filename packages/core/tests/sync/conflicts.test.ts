import { describe, expect, it } from 'vitest';

import {
	frontmatterIsEditable,
	readFrontmatter,
	splitFrontmatter,
} from '../../src/markdown/frontmatter.js';
import { conflictContent } from '../../src/sync/conflicts.js';

/**
 * The contents of a conflict copy: an id of its own, so the copy and the
 * original are never the same note. Its name is `tests/names/conflicts.test.ts`.
 */

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

	it('leaves an id the app cannot read exactly as the user wrote it', () => {
		// YAML reads this as a number, so no device takes it for an identity and
		// the copy competes with nothing by keeping it.
		const zettel = ['---', 'id: 202409141302', 'title: Zettel', '---', '', 'Body', ''].join(
			'\n'
		);
		expect(conflictContent(zettel, 'fresh-id')).toBe(zettel);
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
