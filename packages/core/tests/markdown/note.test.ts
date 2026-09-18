import { describe, expect, it } from 'vitest';

import { contentHash } from '../../src/hash.js';
import { frontmatterHasDeclinedId } from '../../src/markdown/frontmatter.js';
import { parseNoteFile, serializeNoteFile } from '../../src/markdown/note.js';
import { conflictContent } from '../../src/sync/conflicts.js';

describe('parseNoteFile', () => {
	it('reads a note the app wrote', () => {
		const source = [
			'---',
			'id: 018f3c4e',
			'title: Planning',
			'created: 2026-09-14T13:02:11Z',
			'tags: [work]',
			'---',
			'',
			'# Planning',
			'',
			'Body.',
			'',
		].join('\n');

		expect(parseNoteFile(source)).toEqual({
			id: '018f3c4e',
			title: 'Planning',
			created: '2026-09-14T13:02:11Z',
			body: '\n# Planning\n\nBody.\n',
			frontmatter:
				'id: 018f3c4e\ntitle: Planning\ncreated: 2026-09-14T13:02:11Z\ntags: [work]',
			tags: ['work'],
		});
	});

	it('accepts a file written by another tool, with no frontmatter at all', () => {
		const parsed = parseNoteFile('# Just A Note\n\nText.\n', { filename: 'scratch.md' });
		expect(parsed.id).toBeUndefined();
		expect(parsed.frontmatter).toBeNull();
		expect(parsed.title).toBe('Just A Note');
		expect(parsed.tags).toEqual([]);
	});

	it('falls back to the filename for the title', () => {
		expect(parseNoteFile('Text.\n', { filename: 'quick-thought.md' }).title).toBe(
			'quick thought'
		);
	});

	it('changes nothing about the body', () => {
		// `*` bullets and `_em_` are left exactly as the other tool wrote them.
		const body = '* one\n* two\n\n_em_\n';
		expect(parseNoteFile(body).body).toBe(body);
	});
});

describe('serializeNoteFile', () => {
	it('adds frontmatter to a file that had none', () => {
		const output = serializeNoteFile({
			frontmatter: null,
			body: '# A\n',
			metadata: { id: 'abc', title: 'A' },
		});

		expect(output).toBe('---\nid: abc\ntitle: A\n---\n\n# A\n');
	});

	it('edits an existing block in place, preserving unknown keys', () => {
		const output = serializeNoteFile({
			frontmatter: 'id: abc\nobsidian_banner: cover.png',
			body: '\n# A\n',
			metadata: { title: 'New' },
		});

		expect(output).toContain('obsidian_banner: cover.png');
		expect(parseNoteFile(output).title).toBe('New');
	});

	it('writes no frontmatter block when there is nothing to write', () => {
		expect(serializeNoteFile({ frontmatter: null, body: '# A\n', metadata: {} })).toBe('# A\n');
	});

	it('round-trips', () => {
		const source = '---\nid: abc\ntitle: A\n---\n\n# A\n\nBody.\n';
		const parsed = parseNoteFile(source);
		const output = serializeNoteFile({
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			metadata: { id: parsed.id, title: parsed.title },
		});

		expect(output).toBe(source);
	});
});

describe('contentHash', () => {
	it('is stable for the same content', async () => {
		expect(await contentHash('hello')).toBe(await contentHash('hello'));
	});

	it('differs for different content', async () => {
		expect(await contentHash('hello')).not.toBe(await contentHash('hello '));
	});

	it('is lowercase hex of a SHA-256', async () => {
		expect(await contentHash('')).toMatch(/^[0-9a-f]{64}$/);
		// Known SHA-256 of the empty string.
		expect(await contentHash('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('hashes UTF-8 bytes, not code units', async () => {
		expect(await contentHash('日本語')).toMatch(/^[0-9a-f]{64}$/);
	});
});

/**
 * A duplicate key, a tab used to indent a list, an unterminated quote — YAML
 * that is wrong but not unreadable, and that any other editor writes sooner or
 * later. Rejecting the block outright pushed it into the body, and from there
 * every consequence followed: the fences around the raw YAML are a setext
 * heading in markdown, so the YAML became the note's title and therefore its
 * filename, the `id` went missing so the note stopped being the same note, and
 * the next write put a fresh frontmatter block above the old one — which is
 * what the next reader then parses.
 */
describe('a note whose frontmatter the parser had to repair', () => {
	const source = [
		'---',
		'id: 11111111-1111-4111-8111-111111111111',
		'title: Real Title',
		'title: Real Title',
		'---',
		'',
		'# Heading',
		'',
	].join('\n');

	it('keeps the note’s identity', () => {
		expect(parseNoteFile(source).id).toBe('11111111-1111-4111-8111-111111111111');
	});

	it('does not make a title out of the raw YAML', () => {
		expect(parseNoteFile(source).title).toBe('Real Title');
	});

	it('keeps the block out of the body', () => {
		expect(parseNoteFile(source).body).toBe('\n# Heading\n');
	});

	it('leaves the file exactly as it was rather than adding a second block', () => {
		const parsed = parseNoteFile(source);
		const written = serializeNoteFile({
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			metadata: { title: 'Renamed', updated: '2026-09-15T00:00:00Z' },
		});

		// The patch is dropped, not applied: rewriting YAML the parser could only
		// guess at would destroy whatever the user meant by it.
		expect(written).toBe(source);
		expect(written.split('\n').filter((line) => line === '---')).toHaveLength(2);
	});
});

describe('an id the user wrote that the app cannot use', () => {
	const zettel = '---\nid: 202409141302\ntitle: Zettel\n---\nbody\n';

	it('is declined, and the parse says so', () => {
		const parsed = parseNoteFile(zettel);
		expect(parsed.id).toBeUndefined();
		expect(frontmatterHasDeclinedId(parsed.frontmatter)).toBe(true);
	});

	it('is every value that is not a usable string', () => {
		['0123', '1e5', 'true', '[a, b]', '{ a: 1 }', '2024-09-14'].forEach((value) => {
			const declined = frontmatterHasDeclinedId(`id: ${value}\ntitle: X`);
			// A bare date is a string to YAML 1.2, and a string is an id.
			expect(declined).toBe(value !== '2024-09-14');
		});
	});

	it('is not an id the app reads, a missing one, or a key with nothing after it', () => {
		expect(frontmatterHasDeclinedId('id: 018f3c4e-aaaa\ntitle: X')).toBe(false);
		expect(frontmatterHasDeclinedId('id: "202409141302"')).toBe(false);
		expect(frontmatterHasDeclinedId('title: X')).toBe(false);
		expect(frontmatterHasDeclinedId('id:\ntitle: X')).toBe(false);
		expect(frontmatterHasDeclinedId('id: ""\ntitle: X')).toBe(false);
		expect(frontmatterHasDeclinedId(null)).toBe(false);
	});

	it('comes back byte for byte from a writer that asked first', () => {
		const parsed = parseNoteFile(zettel);
		const id = frontmatterHasDeclinedId(parsed.frontmatter) ? {} : { id: 'a-fresh-uuid' };
		const written = serializeNoteFile({
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			metadata: { ...id, title: 'Zettel' },
		});
		expect(written).toBe(zettel);
	});
});

describe('a note file whose block ends in `...`', () => {
	it('gains an id without losing its closer or a byte of its body', () => {
		const body = '\r\nBody text the user wrote.\r\n\r\n---\r\n\r\nmore\r\n';
		const parsed = parseNoteFile(`---\r\ntitle: X\r\n...\r\n${body}`);
		expect(parsed.body).toBe(body);
		expect(
			serializeNoteFile({ frontmatter: parsed.frontmatter, body, metadata: { id: 'abc' } })
		).toBe(`---\r\ntitle: X\r\nid: abc\r\n...\r\n${body}`);
	});

	it('keeps the prose in a conflict copy, which exists to save it', () => {
		const pandoc = '---\ntitle: X\n...\n\nWritten locally.\n\n---\n\nmore\n';
		expect(conflictContent(pandoc, 'copy-id')).toBe(
			'---\ntitle: X\nid: copy-id\n...\n\nWritten locally.\n\n---\n\nmore\n'
		);

		const unclosed = '---\ntitle: X\n\nWritten locally.\n\n---\n\nmore\n';
		expect(conflictContent(unclosed, 'copy-id')).toContain(unclosed);
	});
});
