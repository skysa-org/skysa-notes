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
		// `: : :` recovers as a mapping — `{'': {'': {'': null}}}` — but names
		// nothing that metadata is ever named, so there is no evidence it was
		// meant as anything but a stray line between two thematic breaks.
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

	/**
	 * The same mistakes, in frontmatter written by something other than this app
	 * — which is the case this recovery exists for, since a block this app wrote
	 * is well formed. None of these names a field this app reads, so a gate
	 * asking for one of those five rejected every one of them and handed the
	 * user the whole harm chain: block into the body, YAML as the title, YAML as
	 * the filename, a second block on the next write.
	 */
	const otherTools = {
		'Jekyll, duplicate key':
			'layout: post\ndate: 2026-09-14\ncategories: notes\ncategories: notes',
		'Jekyll, unterminated quote': 'layout: post\npermalink: "/notes/one',
		'Hugo, tab-indented list': 'draft: false\nweight: 10\nkeywords:\n\t- one\n\t- two',
		'Obsidian, duplicate alias': 'aliases: [one]\ncssclass: wide\naliases: [two]',
		'Obsidian, tab-indented list': 'publish: true\naliases:\n\t- one',
		'Docusaurus, duplicate key': 'sidebar_position: 1\ntitle: A\ntitle: A',
		'Astro, unterminated quote': 'pubDate: 2026-01-01\nimage: "./a.png',
		'Pandoc, duplicate key': 'bibliography: refs.bib\nbibliography: refs.bib',
	};

	Object.entries(otherTools).forEach(([what, yaml]) => {
		it(`keeps frontmatter another tool wrote: ${what}`, () => {
			expect(splitFrontmatter(`---\n${yaml}\n---\nBody\n`).frontmatter).toBe(yaml);
		});
	});

	/**
	 * And what that costs, stated rather than discovered. A tool whose block
	 * names only ordinary words — Zettlr writes `author` and `keywords` — is not
	 * rescued, because a note opening `author: me` is likelier to be someone
	 * writing than a tool. Recovering it would mean swallowing the note.
	 */
	it('does not rescue a block that names only ordinary words', () => {
		const source = '---\nauthor: Someone\nkeywords: "one\n---\nBody\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

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

	/**
	 * `apps/web` stores a note under its frontmatter `id`, so a wrong id is not a
	 * wrong field: it is a second row for a note that already exists, and the
	 * first one — with whatever the user had not yet pushed — is left where
	 * nothing will look for it again. Absent is cheap; approximate is not.
	 */
	describe('an id that could not be one', () => {
		it('refuses a value the parser cut short', () => {
			// An unterminated quote on the id line recovers the UUID one character
			// short. Nothing about the string says so — only the parser knows.
			const truncated = readFrontmatter('id: "018f3c4e-1111-4111-8111-111111111111');
			expect(truncated.id).toBeUndefined();
			expect(readFrontmatter("id: '018f3c4e-1111-4111-8111-111111111111").id).toBeUndefined();
		});

		it('refuses prose the parser made a mapping out of', () => {
			expect(readFrontmatter('id: the blue notebook\ntags:\n\t- one').id).toBeUndefined();
		});

		it('refuses a value YAML did not read as a string', () => {
			// `0123` and `123` are one number, so two files collide on one id —
			// and writing it back changes what the user had.
			expect(readFrontmatter('id: 0123\ntitle: A\ntitle: A').id).toBeUndefined();
			expect(readFrontmatter('id: 1e5\ntitle: A\ntitle: A').id).toBeUndefined();
			expect(readFrontmatter('id: 0123').id).toBeUndefined();
		});

		it('leaves a well-formed file alone, whatever it says', () => {
			// Only a block the parser had to repair is second-guessed. A file that
			// parses means what it says, even if this app would not have written it.
			expect(readFrontmatter('id: my note id\ntitle: A').id).toBe('my note id');
		});

		it('still reads everything an id actually looks like', () => {
			expect(readFrontmatter('id: 018f3c4e-1111-4111-8111-111111111111').id).toBe(
				'018f3c4e-1111-4111-8111-111111111111'
			);
			expect(readFrontmatter('id: 018f3c4e\ntitle: A\ntitle: A').id).toBe('018f3c4e');
		});
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
	 * the note's `id` in it, which is what makes the note survive at all.
	 *
	 * The cost is not only that the file misses the change. The app's own row
	 * takes it, the file does not, and the next pull reads the file — so the
	 * rename is undone, and a note left with a filename saying one thing and a
	 * title saying another. `frontmatterIsEditable` exists so the app can say so
	 * in front of the note rather than let the user discover it.
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

describe('a block closed by the YAML document-end marker', () => {
	const pandoc = '---\ntitle: X\n...\n\nBody text the user wrote.\n\n---\n\nmore\n';

	it('ends at `...`, not at the first thematic break after it', () => {
		const { frontmatter, body } = splitFrontmatter(pandoc);
		expect(readFrontmatter(frontmatter)).toEqual({ title: 'X' });
		expect(body).toBe('\nBody text the user wrote.\n\n---\n\nmore\n');
	});

	it('goes back into the file closed the way the file closed it', () => {
		const { frontmatter, body } = splitFrontmatter(pandoc);
		expect(joinFrontmatter(frontmatter, body)).toBe(pandoc);

		const written = writeFrontmatter(frontmatter, { id: 'abc' });
		expect(joinFrontmatter(written, body)).toBe(
			'---\ntitle: X\nid: abc\n...\n\nBody text the user wrote.\n\n---\n\nmore\n'
		);
		// And is still the same block to the next reader.
		expect(splitFrontmatter(joinFrontmatter(written, body)).body).toBe(body);
	});

	it('keeps the closer a line of its own when the block ends in a comment', () => {
		// `yaml` would write this as `... # reviewed`, which closes nothing.
		const { frontmatter, body } = splitFrontmatter('---\ntitle: X\n# reviewed\n...\nbody\n');
		const file = joinFrontmatter(writeFrontmatter(frontmatter, { id: 'abc' }), body);
		expect(file).toMatch(/\n\.\.\.\nbody\n$/);
		expect(readFrontmatter(splitFrontmatter(file).frontmatter)).toEqual({
			id: 'abc',
			title: 'X',
		});
		expect(splitFrontmatter(file).body).toBe('body\n');
	});

	it('reads CRLF and CR files the same way', () => {
		['\r\n', '\r'].forEach((eol) => {
			const { frontmatter, body } = splitFrontmatter(pandoc.replaceAll('\n', eol));
			expect(readFrontmatter(frontmatter)).toEqual({ title: 'X' });
			expect(body.startsWith(`${eol}Body text`)).toBe(true);
		});
	});

	it('does not take an ellipsis under a thematic break for one', () => {
		const source = '---\nNote to self: call the bank\n...\nand then the rest\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	it('still reads a block that holds `...` and is closed by `---`, as it always did', () => {
		const source = '---\nfoo: bar\n...\n---\nbody\n';
		const { frontmatter, body } = splitFrontmatter(source);
		expect(frontmatter).toBe('foo: bar\n...');
		expect(body).toBe('body\n');
		expect(joinFrontmatter(frontmatter, body)).toBe(source);
	});
});

describe('a fence that was never closed', () => {
	it('does not take the prose above the first thematic break as frontmatter', () => {
		const source = '---\ntitle: X\n\nSome prose the user wrote, locally.\n\n---\n\nrest\n';
		expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
	});

	it('still recovers a malformed block whose blank lines are followed by YAML', () => {
		const source =
			'---\ntitle: X\ntitle: Y\n\nid: abc\n\n# a comment\ntags:\n\n  - a\n---\nbody\n';
		const { frontmatter, body } = splitFrontmatter(source);
		expect(readFrontmatter(frontmatter).id).toBe('abc');
		expect(body).toBe('body\n');
	});

	it('leaves a well-formed block scalar alone, blank lines, prose and all', () => {
		const source =
			'---\ntitle: X\nsummary: |\n  First paragraph.\n\n  Second paragraph, with prose: in it.\nnotes: >\n\n  Folded.\n---\nbody\n';
		const { frontmatter, body } = splitFrontmatter(source);
		expect(readFrontmatter(frontmatter)).toEqual({ title: 'X' });
		expect(frontmatter).toContain('Second paragraph');
		expect(body).toBe('body\n');
	});

	it('recovers a block scalar with blank lines in a block that has an error elsewhere', () => {
		const source = '---\ntitle: X\ntitle: Y\nsummary: |\n  One.\n\n  Two.\n---\nbody\n';
		expect(splitFrontmatter(source).body).toBe('body\n');
	});
});

describe('line and paragraph separators', () => {
	it('are not line endings, so a fence after one inside a value closes nothing', () => {
		['\u2028', '\u2029'].forEach((separator) => {
			const source = `---\ntitle: "a${separator}---${separator}b"\nid: abc\n---\nbody\n`;
			const { frontmatter, body } = splitFrontmatter(source);
			expect(readFrontmatter(frontmatter).id).toBe('abc');
			expect(body).toBe('body\n');
		});
	});

	it('do not open or close a block either', () => {
		const source = '---\u2028title: X\n---\nbody\n';
		expect(splitFrontmatter(source).frontmatter).toBeNull();
	});
});
