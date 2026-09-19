import { describe, expect, it } from 'vitest';

import {
	frontmatterIsEditable,
	readFrontmatter,
	splitFrontmatter,
} from '../../src/markdown/frontmatter.js';
import { noteFilename } from '../../src/markdown/slug.js';
import {
	conflictContent,
	conflictFilename,
	conflictFolderName,
	conflictFolderPath,
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

	it('treats a name that differs only in normal form as taken', () => {
		// NFD is what a macOS file and an iOS share sheet hand over, and it is one
		// name with its NFC spelling on every provider. Missed, this copy lands on
		// the existing one and overwrites it — and the copy is the only place the
		// edit that lost the conflict exists.
		const taken = ['caf\u00e9 (conflict 2026-09-15T14-32).md'.normalize('NFD')];

		expect(conflictFilename('caf\u00e9.md', AT, taken)).toBe(
			'caf\u00e9 (conflict 2026-09-15T14-32)-2.md'
		);
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

	it('does not leave a shouted extension on the stem and take a second one', () => {
		// `Report.MD` comes from a Windows tool, and it is a markdown file: the
		// name has one extension, not a stem ending in `.MD` waiting for one.
		expect(conflictFilename('Report.MD', AT)).toBe('Report (conflict 2026-09-15T14-32).md');
	});
});

describe('a conflict name that would not fit in a filename', () => {
	const bytes = (name: string): number => new TextEncoder().encode(name).length;
	const SUFFIX = ' (conflict 2026-09-15T14-32)';

	const expectStorable = (name: string): void => {
		expect(bytes(name)).toBeLessThanOrEqual(255);
		expect(() => encodeURIComponent(name)).not.toThrow();
	};

	it('leaves a name with room for the suffix exactly as it was', () => {
		const slug = noteFilename('\u6f22'.repeat(200));
		expect(bytes(slug)).toBe(219);
		const copy = conflictFilename(slug, AT);
		expect(copy).toBe(`${slug.slice(0, -3)}${SUFFIX}.md`);
		expect(bytes(copy)).toBe(247);
	});

	it('cuts the stem of a copy of a copy, from its end, and keeps both suffixes whole', () => {
		const copy = conflictFilename(noteFilename('\u6f22'.repeat(200)), AT);
		const later = new Date('2026-09-16T09:05:00Z');
		const again = conflictFilename(copy, later);
		expectStorable(again);
		expect(again.startsWith('\u6f22'.repeat(60))).toBe(true);
		expect(again.endsWith(' (conflict 2026-09-16T09-05).md')).toBe(true);
		// 275 bytes uncut. What went is the end of the stem, which here is the
		// first suffix: nothing is stripped on purpose, and nothing is spared.
		expect(bytes(again)).toBeGreaterThan(255 - 3);
	});

	it('cuts a long name from another tool', () => {
		const theirs = `${'n'.repeat(237)}.md`;
		expect(bytes(theirs)).toBe(240);
		const copy = conflictFilename(theirs, AT);
		expectStorable(copy);
		expect(copy).toBe(`${'n'.repeat(255 - 28 - 3)}${SUFFIX}.md`);
	});

	it('does not cut a character in half to do it', () => {
		// Four bytes each, and a joined family of five code points at the cut.
		const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
		[`${'\u{1f389}'.repeat(70)}.md`, `${'a'.repeat(215)}${family}.md`].forEach((name) => {
			const copy = conflictFilename(name, AT);
			expectStorable(copy);
			expect(copy.endsWith(`${SUFFIX}.md`)).toBe(true);
		});
		expect(conflictFilename(`${'a'.repeat(215)}${family}.md`, AT)).toBe(
			`${'a'.repeat(215)}${SUFFIX}.md`
		);
	});

	it('asks whether the name is taken of the name as cut', () => {
		// Two names that differ only past the cut are one name once cut.
		const first = conflictFilename(`${'n'.repeat(236)}A.md`, AT);
		const second = conflictFilename(`${'n'.repeat(236)}B.md`, AT, [first]);
		expectStorable(second);
		expect(second).not.toBe(first);
		expect(second.endsWith(`${SUFFIX}-2.md`)).toBe(true);
		// And the counter is paid for out of the stem, not added on top.
		expect(bytes(second)).toBe(255);
	});

	it('fits a folder name the same way', () => {
		const folder = '\u6f22'.repeat(84);
		const copy = conflictFolderName(folder, AT);
		expectStorable(copy);
		expect(copy.endsWith(SUFFIX)).toBe(true);

		const second = conflictFolderName(folder, AT, [copy]);
		expectStorable(second);
		expect(second.endsWith(`${SUFFIX}-2`)).toBe(true);
	});
});

describe('conflictFolderName', () => {
	// A folder carries no extension, and the only engine caller computes its
	// expectation by calling this same function — so nothing anywhere says what
	// the name should look like.
	it('names a folder the way a note is named, without an extension', () => {
		expect(conflictFolderName('Archive', AT)).toBe('Archive (conflict 2026-09-15T14-32)');
	});

	it('steps aside for a folder name already taken', () => {
		expect(conflictFolderName('Archive', AT, ['Archive (conflict 2026-09-15T14-32)'])).toBe(
			'Archive (conflict 2026-09-15T14-32)-2'
		);
	});

	it('treats a taken name that differs only in case as taken', () => {
		expect(conflictFolderName('Archive', AT, ['archive (CONFLICT 2026-09-15T14-32)'])).toBe(
			'Archive (conflict 2026-09-15T14-32)-2'
		);
	});

	it('keeps a folder whose name ends in .md intact', () => {
		// `conflictFilename` strips the extension; this must not, or a folder
		// someone called `notes.md` comes back as `notes`.
		expect(conflictFolderName('notes.md', AT)).toBe('notes.md (conflict 2026-09-15T14-32)');
	});
});

describe('conflictFolderPath', () => {
	it('renames the folder in place, leaving its parents alone', () => {
		expect(conflictFolderPath('Work/Archive', AT)).toBe(
			'Work/Archive (conflict 2026-09-15T14-32)'
		);
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
