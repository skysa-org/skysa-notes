import { describe, expect, it } from 'vitest';

import {
	joinFrontmatter,
	readFrontmatter,
	splitFrontmatter,
	writeFrontmatter,
} from '../../src/markdown/frontmatter.js';

describe('splitFrontmatter', () => {
	it('splits a fenced YAML mapping from the body', () => {
		expect(splitFrontmatter('---\ntitle: Hi\n---\nBody\n')).toEqual({
			frontmatter: 'title: Hi',
			body: 'Body\n',
		});
	});

	it('treats a file with no frontmatter as all body', () => {
		expect(splitFrontmatter('# Just a note\n')).toEqual({
			frontmatter: null,
			body: '# Just a note\n',
		});
	});

	it('accepts empty frontmatter', () => {
		expect(splitFrontmatter('---\n---\nBody\n')).toEqual({ frontmatter: '', body: 'Body\n' });
	});

	it('requires a closing fence', () => {
		const source = '---\ntitle: Hi\n\nNo closing fence.\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	it('requires the opening fence on the very first line', () => {
		const source = 'Intro\n\n---\ntitle: Hi\n---\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	it('handles CRLF line endings', () => {
		expect(splitFrontmatter('---\r\ntitle: Hi\r\n---\r\nBody\r\n')).toEqual({
			frontmatter: 'title: Hi',
			body: 'Body\r\n',
		});
	});

	it('rejects a fenced block that is not a mapping', () => {
		const source = '---\n\nProse between two thematic breaks.\n\n---\n\nMore.\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	it('rejects a fenced block of invalid YAML rather than eating it', () => {
		// `: : :` recovers as a mapping, but every key in it is empty: nothing in
		// it was named, so there is no evidence it was ever meant as metadata.
		const source = '---\n: : :\n---\nBody\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	/**
	 * The mistakes people actually make in frontmatter. `yaml` reads through all
	 * three, so all three are still frontmatter. Pushing them into the body puts
	 * the raw YAML between two fences, which markdown reads as a setext heading
	 * — and the note then takes its title, and its filename, from its own
	 * metadata.
	 */
	const recoverable = {
		'a duplicate key': 'id: abc\ntitle: Real\ntitle: Real',
		'a tab-indented sequence': 'id: abc\ntags:\n\t- one\n\t- two',
		'an unterminated quote': 'id: abc\ntitle: "oops',
	};

	Object.entries(recoverable).forEach(([what, yaml]) => {
		it(`keeps a block the parser had to recover from: ${what}`, () => {
			expect(splitFrontmatter(`---\n${yaml}\n---\nBody\n`)).toEqual({
				frontmatter: yaml,
				body: 'Body\n',
			});
		});
	});

	/**
	 * The other half of recovery, and the half that decides how much of the
	 * user's writing it costs. `yaml` will make a mapping out of almost any
	 * prose containing a colon, so recovery on its own admits far too much:
	 * every one of these is an ordinary note that happens to open with a rule,
	 * and swallowing it takes that section out of the editor, where the user can
	 * no longer read it, change it, or delete it.
	 *
	 * A document the parser had to repair therefore has to carry a key the app
	 * actually reads before it counts as frontmatter.
	 */
	const notFrontmatter = {
		'a line with a colon in it': 'Next steps: see below\n- Do the thing',
		'two of them': 'Note: first point\nNote: second point',
		'a tab-indented list under one': 'Agenda: today\n\t- one\n\t- two',
		'a checklist': 'Status: open\n- [ ] one\n- [x] two',
		'a code fence': 'Example: run this\n```sh\nls\n```',
		'a block quote': 'Quote: someone said\n> hello',
		'ratios and an unclosed quote': 'Ratio: 3:1\nMix: 2:1:1\nOther: "unclosed',
	};

	Object.entries(notFrontmatter).forEach(([what, text]) => {
		it(`leaves prose in the body even though YAML can read it: ${what}`, () => {
			const source = `---\n${text}\n---\nBody\n`;
			expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
		});
	});

	it('is inverted exactly by joinFrontmatter', () => {
		for (const source of [
			'---\ntitle: Hi\n---\n\nBody\n',
			'---\n---\nBody\n',
			'# No frontmatter\n',
			'',
		]) {
			const { frontmatter, body } = splitFrontmatter(source);
			expect(joinFrontmatter(frontmatter, body)).toBe(source);
		}
	});
});

describe('joinFrontmatter', () => {
	it('returns the body unchanged when there is no frontmatter', () => {
		expect(joinFrontmatter(null, '# Note\n')).toBe('# Note\n');
	});

	it('terminates the YAML block even if the caller forgot the newline', () => {
		expect(joinFrontmatter('title: Hi', 'Body\n')).toBe('---\ntitle: Hi\n---\nBody\n');
	});
});

describe('readFrontmatter', () => {
	it('reads the fields the app understands', () => {
		const data = readFrontmatter(
			[
				'id: 018f3c4e',
				'title: Planning',
				'created: 2026-09-14T13:02:11Z',
				'tags: [a, b]',
			].join('\n')
		);
		expect(data).toEqual({
			id: '018f3c4e',
			title: 'Planning',
			created: '2026-09-14T13:02:11Z',
			tags: ['a', 'b'],
		});
	});

	it('returns nothing for a file with no frontmatter', () => {
		expect(readFrontmatter(null)).toEqual({});
	});

	it('accepts a comma-separated tag string', () => {
		expect(readFrontmatter('tags: planning, work').tags).toEqual(['planning', 'work']);
	});

	it('accepts a block sequence of tags', () => {
		expect(readFrontmatter('tags:\n  - planning\n  - work').tags).toEqual(['planning', 'work']);
	});

	it('keeps a bare date as written, since YAML 1.2 has no timestamp type', () => {
		expect(readFrontmatter('created: 2026-09-14').created).toBe('2026-09-14');
	});

	it('treats malformed YAML as no data instead of throwing', () => {
		expect(readFrontmatter(': : :')).toEqual({});
	});

	it('recovers the id from YAML the parser had to repair', () => {
		// Losing the id is the one outcome a note cannot survive: on the next
		// import it is a different note, and the one it used to be is orphaned.
		expect(readFrontmatter('id: abc\ntitle: Real\ntitle: Real').id).toBe('abc');
		expect(readFrontmatter('id: abc\ntags:\n\t- one').id).toBe('abc');
		expect(readFrontmatter('id: abc\ntitle: "oops').id).toBe('abc');
	});

	it('ignores a YAML document that is not a mapping', () => {
		expect(readFrontmatter('- just\n- a list')).toEqual({});
	});

	it('ignores fields of the wrong shape', () => {
		expect(readFrontmatter('title:\n  nested: value')).toEqual({});
	});
});

describe('writeFrontmatter', () => {
	it('creates frontmatter when a file had none', () => {
		const yaml = writeFrontmatter(null, { id: 'abc', title: 'Hi' });
		expect(readFrontmatter(yaml)).toEqual({ id: 'abc', title: 'Hi' });
	});

	it('updates a field in place', () => {
		const yaml = writeFrontmatter('id: abc\ntitle: Old\n', { title: 'New' });
		expect(readFrontmatter(yaml).title).toBe('New');
		expect(readFrontmatter(yaml).id).toBe('abc');
	});

	it('preserves keys the app does not know about', () => {
		const yaml = writeFrontmatter('id: abc\nobsidian_banner: cover.png\naliases: [x]\n', {
			title: 'New',
		});
		expect(yaml).toContain('obsidian_banner: cover.png');
		// Re-stringifying may normalize spacing inside a flow collection, but the
		// key and its values survive.
		expect(readFrontmatter(yaml)).toMatchObject({ id: 'abc', title: 'New' });
		expect(yaml).toMatch(/aliases: \[ ?x ?\]/);
	});

	it('preserves comments and key order', () => {
		const yaml = writeFrontmatter('# my notes header\nid: abc\ntitle: Old\n', { title: 'New' });
		expect(yaml).toContain('# my notes header');
		expect(yaml.indexOf('id:')).toBeLessThan(yaml.indexOf('title:'));
	});

	it('removes a field set to undefined', () => {
		const yaml = writeFrontmatter('id: abc\ntitle: Old\n', { title: undefined });
		expect(yaml).not.toContain('title');
		expect(yaml).toContain('id: abc');
	});

	it('leaves a field alone when the patch does not mention it', () => {
		const yaml = writeFrontmatter('id: abc\ntitle: Old\n', {});
		expect(readFrontmatter(yaml)).toEqual({ id: 'abc', title: 'Old' });
	});

	it('never rewrites YAML it cannot parse', () => {
		const broken = ': : :';
		expect(writeFrontmatter(broken, { title: 'New' })).toBe(broken);
	});

	/**
	 * Known limitation, pinned here so it stays a decision rather than a
	 * surprise: a block the parser had to recover from is readable but not
	 * editable, so a patch to one is dropped. `readFrontmatter` will now find
	 * the note's `id` in it, which is what makes the note survive at all — but
	 * a rename or a tag edit reaches the app's own row and never reaches the
	 * file, and the user is told nothing.
	 *
	 * The alternative is to rebuild the block from what the parser recovered,
	 * which would silently write `title: oop` over the user's `title: "oops`.
	 * Refusing is the safer half of a choice with no good half; the place where
	 * refusing is not acceptable is `conflictContent`, which cannot let two
	 * files claim one id and therefore rebuilds — see `sync/conflicts.ts`.
	 */
	it('drops a patch to a block the parser had to recover from', () => {
		const recovered = 'id: abc\ntitle: Real\ntitle: Real';
		expect(writeFrontmatter(recovered, { title: 'New' })).toBe(recovered);
		expect(readFrontmatter(writeFrontmatter(recovered, { title: 'New' })).title).toBe('Real');
	});

	it('round-trips through split and join', () => {
		const file = '---\nid: abc\ncustom: keep\n---\n\n# Body\n';
		const { frontmatter, body } = splitFrontmatter(file);
		const updated = joinFrontmatter(writeFrontmatter(frontmatter, { title: 'Set' }), body);
		const reread = splitFrontmatter(updated);
		expect(readFrontmatter(reread.frontmatter)).toEqual({ id: 'abc', title: 'Set' });
		expect(reread.frontmatter).toContain('custom: keep');
		expect(reread.body).toBe(body);
	});
});
