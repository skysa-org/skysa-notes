import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import {
	joinFrontmatter,
	readFrontmatter,
	splitFrontmatter,
	writeFrontmatter,
} from '../../src/markdown/frontmatter.js';
import { type LineEnding, withLineEnding } from '../../src/markdown/lineEndings.js';
import { serializeNoteFile } from '../../src/markdown/note.js';

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
		expect(readFrontmatter(yaml)).toMatchObject({ id: 'abc', title: 'New' });
		// As written, spacing and all: see "values the app did not change" below.
		expect(yaml).toContain('aliases: [x]\n');
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

/** Every input below in the three spellings of a line ending the splitter reads. */
const inEachEnding = (source: string): readonly string[] =>
	['\n', '\r\n', '\r'].map((eol) => source.replaceAll('\n', eol));

describe('a repaired block with a blank line in it', () => {
	it('is still frontmatter when what follows is a key with a space in it', () => {
		// Obsidian's `date created:`, under a duplicate key the parser repairs.
		inEachEnding(
			'---\nid: abc\ntags: a\ntags: b\n\ndate created: 2024-01-01\n---\nbody\n'
		).forEach((source) => {
			const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? '';
			expect(splitFrontmatter(source)).toEqual({
				frontmatter: ['id: abc', 'tags: a', 'tags: b', '', 'date created: 2024-01-01'].join(
					eol
				),
				body: `body${eol}`,
			});
			expect(readFrontmatter(splitFrontmatter(source).frontmatter).id).toBe('abc');
		});
	});
});

describe('`...` where `---` never closed the block', () => {
	it('is an ellipsis when the lines above it are not clean YAML', () => {
		[
			'---\ntitle: Poem\nAnd then it rained\n...\nthe end\n',
			'---\ntitle: Trip\n\nTodo: pack bags\nand so on\n...\nlater\n',
			// An error the parser would repair is not repaired here.
			'---\ntitle: X\ntitle: Y\n...\nbody\n',
		]
			.flatMap(inEachEnding)
			.forEach((source) => {
				expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
			});
	});
});

describe('`...` inside a block that `---` closes', () => {
	it('closes nothing: the block ends where it always ended', () => {
		inEachEnding('---\ntitle: a\n...\n---\nbody\n').forEach((source) => {
			const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? '';
			expect(splitFrontmatter(source)).toEqual({
				frontmatter: `title: a${eol}...`,
				body: `body${eol}`,
			});
		});

		// Blank lines between the two closers are still nothing between them.
		expect(splitFrontmatter('---\ntitle: a\n...\n\n---\nbody\n')).toEqual({
			frontmatter: 'title: a\n...\n',
			body: 'body\n',
		});
	});

	it('gets its `---` back when the block is rewritten, `...` above it or not', () => {
		const { frontmatter, body } = splitFrontmatter('---\ntitle: a\n...\n---\nbody\n');
		expect(joinFrontmatter(frontmatter, body)).toBe('---\ntitle: a\n...\n---\nbody\n');
		expect(joinFrontmatter(writeFrontmatter(frontmatter, { id: 'abc' }), body)).toBe(
			'---\ntitle: a\nid: abc\n...\n---\nbody\n'
		);
	});
});

describe('a pandoc block with anything under it before the first `---`', () => {
	const bodyOf = (source: string): string => splitFrontmatter(source).body;

	it('ends at `...`, blank line under it or not', () => {
		// A setext heading straight under the block.
		expect(bodyOf('---\ntitle: Trip\n...\nDay one\n---\nWe left early.\n')).toBe(
			'Day one\n---\nWe left early.\n'
		);
		// A slide deck: `# Slide 1` is a comment to YAML, so the `---` reading of
		// this parses without an error and used to take the heading with it.
		expect(bodyOf('---\ntitle: Deck\n...\n\n# Slide 1\n\n---\n\n# Slide 2\n')).toBe(
			'\n# Slide 1\n\n---\n\n# Slide 2\n'
		);
		expect(
			bodyOf('---\ntitle: Foo\n...\n# Heading right under\n\nText: more\n\n---\n\nrest\n')
		).toBe('# Heading right under\n\nText: more\n\n---\n\nrest\n');
	});

	it('reads the same after the app has written to the block', () => {
		// The write tidies the blank line above `...` away; a rule that counted
		// blank lines read this one way before the first save and another after,
		// and "Day one" left the editor.
		const source = '---\ntitle: Trip\n\n...\nDay one\n---\nWe left early.\n';
		const first = splitFrontmatter(source);
		expect(first.body).toBe('Day one\n---\nWe left early.\n');

		const written = joinFrontmatter(
			writeFrontmatter(first.frontmatter, { id: 'abc' }),
			first.body
		);
		const second = splitFrontmatter(written);
		expect(second.body).toBe(first.body);
		expect(readFrontmatter(second.frontmatter)).toEqual({ id: 'abc', title: 'Trip' });
	});

	it('survives the blank line under it being deleted', () => {
		const written = '---\ntitle: a\nid: abc\n...\nIntro line\n\n---\n\nrest\n';
		expect(bodyOf(written)).toBe('Intro line\n\n---\n\nrest\n');
	});
});

describe('a repaired block with a slip under a blank line', () => {
	it('is still frontmatter: one word, or a template tag, is not a sentence', () => {
		[
			'---\nid: abc\ntitle: Trip\n\nurl:http://example.com\n---\nbody\n',
			'---\nid: abc\ntitle: a\ntitle: b\n\n<% tp.file.cursor() %>\n---\nbody\n',
			'---\nid: abc\ntitle: Trip: two\n\ndescription\n---\nbody\n',
			'---\nid: abc\ntitle: a\ntitle: b\ntags: [a,\n\nb]\n---\nbody\n',
		]
			.flatMap(inEachEnding)
			.forEach((source) => {
				const { frontmatter, body } = splitFrontmatter(source);
				expect(readFrontmatter(frontmatter).id, JSON.stringify(source)).toBe('abc');
				expect(body.trim()).toBe('body');
			});
	});
});

describe('a pandoc block run together with the paragraph under it', () => {
	it('ends at `...` even when the paragraph could pass for YAML', () => {
		inEachEnding('---\ntitle: X\n...\n\nNote: remember this\n\n---\n\nmore\n').forEach(
			(source) => {
				const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? '';
				const { frontmatter, body } = splitFrontmatter(source);
				expect(readFrontmatter(frontmatter)).toEqual({ title: 'X' });
				expect(body).toBe(['', 'Note: remember this', '', '---', '', 'more', ''].join(eol));
				expect(
					withLineEnding(joinFrontmatter(frontmatter, ''), eol as LineEnding) + body
				).toBe(source);
			}
		);
	});
});

/**
 * `splitFrontmatter` as it stood before `...` closed anything, kept to say
 * exactly what changed: every input below splits the way it did, except the
 * ones that name why not.
 */
const LEGACY_EOL = String.raw`(?:\r\n|\n|\r)`;
const LEGACY_PATTERN = new RegExp(
	String.raw`^---[ \t]*${LEGACY_EOL}([\s\S]*?)(?:${LEGACY_EOL})?^---[ \t]*(?:${LEGACY_EOL}|$)`,
	'm'
);
const LEGACY_KEYS = [
	...['id', 'title', 'created', 'updated', 'tags', 'aliases', 'bibliography', 'cssclass'],
	...['cssclasses', 'jupyter', 'layout', 'marp', 'permalink', 'pubDate', 'publish'],
	...['sidebar_position', 'slug', 'taxonomies', 'weight'],
];

const legacyIsBlock = (yaml: string): boolean => {
	if (yaml.trim() === '') return true;
	try {
		const doc = parseDocument(yaml.replace(/\r\n|\r/g, '\n'));
		const data: unknown = doc.toJS();
		if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
		return doc.errors.length === 0 || LEGACY_KEYS.some((key) => Object.hasOwn(data, key));
	} catch {
		return false;
	}
};

const legacySplit = (source: string): { frontmatter: string | null; body: string } => {
	const match = source.startsWith('---') ? LEGACY_PATTERN.exec(source) : null;
	if (match === null || match.index !== 0 || !legacyIsBlock(match[1] ?? '')) {
		return { frontmatter: null, body: source };
	}
	return { frontmatter: match[1] ?? '', body: source.slice(match[0].length) };
};

describe('splitFrontmatter, against what it did before', () => {
	const UNCHANGED = [
		'',
		'body\n',
		'---\n',
		'---',
		'---\n---\n',
		'---\n---',
		'---\n\n---\nbody\n',
		'---\n---\nbody\n---\nmore\n',
		'---\ntitle: a\n---\nbody\n',
		'---  \ntitle: a\n---\t\nbody\n',
		'---\ntitle: a\n----\nbody\n---\nx\n',
		'----\ntitle: a\n---\nbody\n',
		'---\ntitle: a\n---',
		'---\njust prose\n---\nbody\n',
		'---\n- a\n- b\n---\nbody\n',
		'---\nNext steps: see below\n- do the thing\n---\nbody\n',
		'---\ntitle: "unterminated\nid: abc\n---\nbody\n',
		'---\nid: abc\ntags: a\ntags: b\n---\nbody\n',
		'---\nid: abc\ntags: a\ntags: b\n\ndate created: 2024-01-01\n---\nbody\n',
		'---\nid: abc\ntags:\n\t- a\n\n"quoted key": 1\n---\nbody\n',
		'---\ntitle: X\nsummary: |\n  One.\n\n  Two, with prose: in it.\n---\nbody\n',
		'---\ntitle: X\ntitle: Y\nsummary: |\n  One.\n\n  Two.\n---\nbody\n',
		'---\ntitle: X\n\n# only a comment\n\nid: abc\n---\nbody\n',
		'---\ntitle: Poem\nAnd then it rained\n...\nthe end\n',
		'---\ntitle: Trip\n\nTodo: pack bags\nand so on\n...\nlater\n',
		'---\nNote to self: call the bank\n...\nand then the rest\n',
		'---\ntitle: a\n...\n---\nbody\n',
		'---\nfoo: bar\n...\n---\nbody\n',
		'---\ntitle: a\n...\n\n---\nbody\n',
		'---\nid: abc\ntitle: Trip\n\nurl:http://example.com\n---\nbody\n',
		'---\nid: abc\ntitle: a\ntitle: b\n\n<% tp.file.cursor() %>\n---\nbody\n',
		'---\n...\nbody\n',
		'---\ntext\n...\nbody\n',
	];

	it('splits these exactly as it did, in every line ending', () => {
		UNCHANGED.flatMap(inEachEnding).forEach((source) => {
			expect(splitFrontmatter(source), JSON.stringify(source)).toEqual(legacySplit(source));
		});
	});

	const CHANGED: readonly (readonly [why: string, source: string])[] = [
		[
			'`...` closes a clean block that `---` never closed; it was all body',
			'---\ntitle: X\n...\nbody\n',
		],
		[
			'a pandoc block no longer runs on to the first thematic break of the note',
			'---\ntitle: X\n...\n\nBody text the user wrote.\n\n---\n\nmore\n',
		],
		[
			'the same, where the paragraph has a colon in it and so passes for YAML',
			'---\ntitle: X\n...\n\nNote: remember this\n\n---\n\nmore\n',
		],
		[
			'YAML ends its document at `...`: what follows was never read as metadata, only hidden',
			'---\ntitle: x\nnote: |\n  a\n...\nstill: yaml\n---\nbody\n',
		],
		[
			'a setext heading straight under a pandoc block is the note, not the block',
			'---\ntitle: Trip\n...\nDay one\n---\nWe left early.\n',
		],
		[
			'a slide deck keeps its first slide, which YAML reads as a comment',
			'---\ntitle: Deck\n...\n\n# Slide 1\n\n---\n\n# Slide 2\n',
		],
		[
			'a fence nobody closed no longer takes the prose under it; it is all body',
			'---\ntitle: X\n\nSome prose the user wrote, locally.\n\n---\n\nrest\n',
		],
		[
			'U+2028 is not a line ending, so a fence after one closes nothing',
			'---\ntitle: "a\u2028---\u2028b"\nid: abc\n---\nbody\n',
		],
	];

	it('and differs on these, each for a reason', () => {
		CHANGED.flatMap(([why, source]) => inEachEnding(source).map((each) => [why, each])).forEach(
			([why, source]) => {
				expect(splitFrontmatter(source ?? ''), why).not.toEqual(legacySplit(source ?? ''));
			}
		);
	});
});

describe('writeFrontmatter, over an `id` the app declined', () => {
	it('neither replaces it nor respells it, whatever else the patch sets', () => {
		expect(writeFrontmatter('title: a\nid: 0123', { title: 'T', id: 'uuid' })).toBe(
			'title: T\nid: 0123\n'
		);
		expect(writeFrontmatter('title: a\nid: +12 # mine\nx: 1', { title: 'T' })).toBe(
			'title: T\nid: +12 # mine\nx: 1\n'
		);
		expect(writeFrontmatter('id: 0x1F\ntitle: a', { tags: ['a'] })).toBe(
			'id: 0x1F\ntitle: a\ntags:\n  - a\n'
		);
		// Nothing to write, so nothing is: not even the spacing inside the list.
		expect(writeFrontmatter('id: [1, 2]\ntitle: a', { id: 'uuid' })).toBe(
			'id: [1, 2]\ntitle: a'
		);
	});

	it('still fills in an `id:` nobody gave a value, and still removes one when asked', () => {
		expect(writeFrontmatter('id:\ntitle: a', { id: 'uuid' })).toBe('id: uuid\ntitle: a\n');
		expect(writeFrontmatter('id: 0123\ntitle: a', { id: undefined })).toBe('title: a\n');
	});
});

describe('writeFrontmatter, emptying a block that `...` closed', () => {
	it('writes one that is still read as a block', () => {
		const written = writeFrontmatter('---\ntitle: a\n...', { title: undefined });
		expect(splitFrontmatter(joinFrontmatter(written, 'body\n'))).toEqual({
			frontmatter: '{}',
			body: 'body\n',
		});
	});
});

describe('a block that `...` closed, written back', () => {
	it('takes a `---` closer when the body has come to open with a `---` line', () => {
		// Left under the `...`, that line is read as the block's closing fence and
		// the rule the user typed leaves the editor.
		const { frontmatter } = splitFrontmatter('---\ntitle: a\nid: abc\n...\nfirst\n');
		['---\n\nrest\n', '\n---\n\nrest\n', '\n\n---\nrest\n---\nmore\n'].forEach((body) => {
			const again = splitFrontmatter(joinFrontmatter(frontmatter, body));
			expect(again.body, JSON.stringify(body)).toBe(body);
			expect(readFrontmatter(again.frontmatter)).toEqual({ id: 'abc', title: 'a' });
		});
		// And keeps its own closer otherwise.
		expect(joinFrontmatter(frontmatter, 'first\n')).toBe(
			'---\ntitle: a\nid: abc\n...\nfirst\n'
		);
	});

	it('is still read as a block when a patch takes its last metadata key away', () => {
		const written = writeFrontmatter('---\ntitle: a\nfoo: b\n...', { title: undefined });
		expect(splitFrontmatter(joinFrontmatter(written, 'body\n'))).toEqual({
			frontmatter: 'foo: b',
			body: 'body\n',
		});
	});
});

describe('an `id` that is an alias', () => {
	it('is written as it is read: not declined, where what it points at is a usable id', () => {
		const block = 'x: &z abc\nid: *z\ntitle: a';
		expect(readFrontmatter(block).id).toBe('abc');
		expect(readFrontmatter(writeFrontmatter(block, { id: 'uuid' })).id).toBe('uuid');
	});
});

/**
 * The writer used to stringify the whole document to change one key, and a
 * stringifier has an opinion about every scalar it meets. Each line below is
 * something a person wrote in their own file, that the app was never asked to
 * touch, and that came back different after a rename.
 */
describe('writeFrontmatter, over values the app did not change', () => {
	const kept = {
		'a leading zero': 'zip: 02134',
		'a hexadecimal number': 'mask: 0x1F',
		'an integer too long for a double': 'id2: 12345678901234567890',
		'a float with its trailing zero': 'ratio: 1.50',
		'an exponent': 'big: 1E3',
		'a quoted string with an escape in it': String.raw`author: "Zoë"`,
		'a single-quoted string that needed no quotes': "place: 'Here'",
		'a flow list, spaced the way it was': 'aliases: [one,two]',
		'a flow mapping': 'geo: {lat: 1,lon: 2}',
		'a block list indented further than the app would': 'aliases:\n    - one\n    - two',
		'a list that is not indented at all': 'aliases:\n- one\n- two',
		'a comment, however it is spaced': '#kept by hand\nweight: 1   #and this',
		'a null spelled with a tilde': 'parent: ~',
		'a boolean in capitals': 'publish: TRUE',
		'a long line the stringifier would fold': `summary: ${'word '.repeat(30).trim()}`,
		'a blank line between keys': 'layout: post\n\nslug: a-note',
	};

	Object.entries(kept).forEach(([what, lines]) => {
		it(`keeps ${what}`, () => {
			expect(writeFrontmatter(`id: abc\n${lines}\ntitle: Old`, { title: 'New' })).toBe(
				`id: abc\n${lines}\ntitle: New\n`
			);
		});
	});

	it('keeps the order the keys were in, and puts a new one under the last', () => {
		expect(
			writeFrontmatter('updated: 2026-01-01T00:00:00.000Z\nzip: 02134\ntitle: Old\nid: abc', {
				id: 'abc',
				title: 'New',
				tags: ['a'],
			})
		).toBe(
			'updated: 2026-01-01T00:00:00.000Z\nzip: 02134\ntitle: New\nid: abc\ntags:\n  - a\n'
		);
	});

	/**
	 * What a save looks like from here: the store hands back every field it
	 * holds, because it cannot know which of them the user touched. Being named
	 * in the patch is therefore not a change — differing from the file is.
	 */
	const saved = {
		id: 'abc',
		title: 'Trip',
		created: '2024-09-14T00:00:00.000Z',
		updated: '2026-03-01T10:00:00.000Z',
		tags: ['work', 'home'],
	};

	it('returns its input, byte for byte, when the patch says what the file says', () => {
		[
			'id: abc\ntitle: Trip\ncreated: 2024-09-14\nupdated: 2026-03-01T10:00:00Z\ntags: [work,home]',
			'id: "abc"\ntitle:   Trip\ncreated: 2024-09-14\nupdated: 2026-03-01 10:00:00Z\ntags: work, home\n',
			"id: abc\r\ntitle: 'Trip'\r\ncreated: 2024-09-14\r\nupdated: 2026-03-01T10:00:00.000Z\r\ntags:\r\n- work\r\n- home\r\nzip: 02134\r\n",
			'---\nid: abc\ntitle: Trip\ncreated: 2024-09-14\nupdated: 2026-03-01T10:00:00Z\ntags: [ work, home ]\n...',
		].forEach((block) => {
			expect(writeFrontmatter(block, saved), JSON.stringify(block)).toBe(block);
		});
		// A title YAML reads as a number is the title the app was shown.
		expect(readFrontmatter('id: abc\ntitle: 007').title).toBe('7');
		expect(writeFrontmatter('id: abc\ntitle: 007', { id: 'abc', title: '7' })).toBe(
			'id: abc\ntitle: 007'
		);
		expect(writeFrontmatter('zip: 02134\nid: [1,2]', {})).toBe('zip: 02134\nid: [1,2]');
	});

	it('leaves `created` as the user spelled it, and still moves `updated`', () => {
		const block =
			'id: abc\ntitle: Trip\ncreated: 2024-09-14\nupdated: 2025-01-01\ntags: work, home';
		expect(writeFrontmatter(block, saved)).toBe(
			'id: abc\ntitle: Trip\ncreated: 2024-09-14\nupdated: 2026-03-01T10:00:00.000Z\ntags: work, home\n'
		);
	});

	it('does not put the time of the import over a `created` it could not read', () => {
		// The store has no date for this note but the day it first saw the file,
		// and that is what it hands back. It is nobody's creation date.
		const block = 'id: abc\ntitle: Trip\ncreated: last spring\nupdated: whenever';
		const written = writeFrontmatter(block, { ...saved, tags: undefined });
		expect(written).toBe(
			'id: abc\ntitle: Trip\ncreated: last spring\nupdated: 2026-03-01T10:00:00.000Z\n'
		);
		expect(writeFrontmatter('created: [2024, 9]\ntitle: a', { created: saved.created })).toBe(
			'created: [2024, 9]\ntitle: a'
		);
		// Nothing there is not something someone wrote, and it can still be removed.
		expect(writeFrontmatter('created:\ntitle: a', { created: saved.created })).toBe(
			`created: ${saved.created}\ntitle: a\n`
		);
		expect(writeFrontmatter(block, { created: undefined })).toBe(
			'id: abc\ntitle: Trip\nupdated: whenever\n'
		);
	});

	it('writes the keys it does change, in place, and adds the ones that are new', () => {
		const block = '# mine\nzip: 02134\ntitle: "Old" # renamed twice\ntags: [a, b]\n\n# end\n';
		expect(writeFrontmatter(block, { title: 'New: one' })).toBe(
			'# mine\nzip: 02134\ntitle: "New: one" # renamed twice\ntags: [a, b]\n\n# end\n'
		);
		expect(writeFrontmatter(block, { tags: ['a', 'c'] })).toBe(
			'# mine\nzip: 02134\ntitle: "Old" # renamed twice\ntags:\n  - a\n  - c\n\n# end\n'
		);
		expect(
			writeFrontmatter(block, { tags: undefined, id: 'abc', updated: saved.updated })
		).toBe(
			`# mine\nzip: 02134\ntitle: "Old" # renamed twice\nid: abc\nupdated: ${saved.updated}\n\n# end\n`
		);
		const again = writeFrontmatter(block, { title: 'New', tags: ['c'], id: 'abc' });
		expect(readFrontmatter(again)).toEqual({ id: 'abc', title: 'New', tags: ['c'] });
		expect(again).toContain('zip: 02134\n');
	});

	it('replaces a value that ran over several lines, and only that', () => {
		expect(
			writeFrontmatter(
				'title: >-\n  A long\n  title\nzip: 02134\ntags:\n    - a\n    - b\nx: 0x1F',
				{
					title: 'Short',
					tags: ['c'],
				}
			)
			// `yaml` keeps the style a scalar had when it is given a new value, as
			// it always has here. It is the user's style, and it reads as `Short`.
		).toBe('title: >-\n  Short\nzip: 02134\ntags:\n  - c\nx: 0x1F\n');
	});

	it('keeps the line endings of a file that is CRLF throughout', () => {
		const file = '---\r\nzip: 02134\r\ntitle: Old\r\nmask: 0x1F\r\n---\r\n\r\nbody\r\n';
		const { frontmatter, body } = splitFrontmatter(file);
		expect(serializeNoteFile({ frontmatter, body, metadata: { title: 'New' } })).toBe(
			file.replace('Old', 'New')
		);
		expect(serializeNoteFile({ frontmatter, body, metadata: { title: 'Old' } })).toBe(file);
	});

	it('under a `...` closer too', () => {
		const { frontmatter, body } = splitFrontmatter('---\ntitle: Old\nzip: 02134\n...\nbody\n');
		expect(joinFrontmatter(writeFrontmatter(frontmatter, { title: 'New' }), body)).toBe(
			'---\ntitle: New\nzip: 02134\n...\nbody\n'
		);
	});

	/**
	 * Pairs that do not sit one to a line at the left margin cannot be lifted
	 * out by line, and no tool writes a block that way. Such a block is written
	 * whole, as every block used to be — the patch lands and a declined `id` is
	 * still spelled as it was, which is all that was ever promised of one.
	 */
	it('still writes a block it cannot take apart line by line', () => {
		['{title: a, id: 0123}', '  title: a\n  id: 0123', '? title\n: a\n? id\n: 0123'].forEach(
			(block) => {
				const written = writeFrontmatter(block, { title: 'T', id: 'uuid' });
				expect(readFrontmatter(written), block).toEqual({ title: 'T' });
				expect(written, block).toContain('0123');
			}
		);
	});
});

/**
 * What a fuzzer found in the splice. Each of these parsed, which is all the
 * splice asked of its result, and each said something the file had not.
 */
describe('writeFrontmatter, where lifting a pair out by line is not enough', () => {
	it('does not let a deleted pair leave its blank line to a scalar that keeps them', () => {
		// `|+` keeps every trailing blank line, so the one under `tags` would read
		// as one more line of `k`: a key nobody touched, with a different value.
		['|+', '>+'].forEach((style) => {
			const block = `k: ${style}\n  keep\n\ntags: a\n\nz: 1\n`;
			const written = writeFrontmatter(block, { tags: undefined });
			expect(parseDocument(written).toJS(), style).toEqual({ k: 'keep\n\n', z: 1 });
		});
		const titled = writeFrontmatter('k: |+\n  keep\n\ntitle: a\n\nz: 1\n', {
			title: undefined,
		});
		expect(parseDocument(titled).toJS()).toEqual({ k: 'keep\n\n', z: 1 });
	});

	/**
	 * `yaml` gives a key with no value every comment line under it, down to the
	 * next key. `tags:` with nothing after it is how a template leaves the key.
	 */
	it('leaves a comment under a key with no value where it was', () => {
		const cases: readonly (readonly [
			string,
			Parameters<typeof writeFrontmatter>[1],
			string,
		])[] = [
			['tags:\n# about k2\nk2: x\n', { tags: ['p'] }, 'tags:\n  - p\n# about k2\nk2: x\n'],
			['tags:\n# about k2\nk2: x\n', { tags: undefined }, '# about k2\nk2: x\n'],
			['title:\n# about k2\nk2: x\n', { title: 'b' }, 'title: b\n# about k2\nk2: x\n'],
			[
				'title: # todo\n# about k2\nk2: x\n',
				{ title: 'b' },
				'title: b # todo\n# about k2\nk2: x\n',
			],
			[
				'title:\n\n# comment 0\n\n',
				{ title: 'New Title' },
				'title: New Title\n\n# comment 0\n\n',
			],
			// A new key still goes under everything the block had.
			[
				'title: a\ntags:\n# last word\n',
				{ id: 'abc' },
				'title: a\ntags:\n# last word\nid: abc\n',
			],
		];
		cases.forEach(([block, patch, expected]) => {
			const written = writeFrontmatter(block, patch);
			expect(written, JSON.stringify(block)).toBe(expected);
			expect(writeFrontmatter(written, patch), JSON.stringify(block)).toBe(written);
		});
	});

	it('hands back a block `yaml` cannot evaluate, rather than throwing', () => {
		// An alias above its anchor parses without an error and throws when read.
		const block = 'title: *t\nother: &t x\n';
		expect(writeFrontmatter(block, { title: 'b' })).toBe(block);
		expect(writeFrontmatter(block, { id: 'abc' })).toBe(block);
	});

	it('does not write over a value another line reads through an anchor', () => {
		// `title: &t b` would have renamed `other` too, and nobody asked for that.
		const titled = 'title: &t a\nother: *t\n';
		expect(writeFrontmatter(titled, { title: 'b' })).toBe(titled);
		expect(writeFrontmatter(titled, { title: undefined })).toBe(titled);

		const tagged = 'tags: &t [a]\nother: *t\n';
		expect(writeFrontmatter(tagged, { tags: ['b'] })).toBe(tagged);
		expect(writeFrontmatter(tagged, { tags: undefined })).toBe(tagged);
		// An anchor inside the value is one `yaml` will not write without, either.
		const nested = 'tags: [&t a]\nother: *t\n';
		expect(writeFrontmatter(nested, { tags: undefined })).toBe(nested);

		// A key nobody anchored is still written, under the same roof.
		expect(writeFrontmatter(titled, { id: 'abc' })).toBe('title: &t a\nother: *t\nid: abc\n');
	});

	it('keeps the comment on the line of a list it replaces', () => {
		const written = writeFrontmatter('tags: [a, b] # my tags\nzip: 02134\n', { tags: ['c'] });
		// Above the items: a block list has no line of its own to carry it on.
		expect(written).toBe('tags:\n  # my tags\n  - c\nzip: 02134\n');
		// And it stays there, over a second change and over a template's `tags:`.
		expect(writeFrontmatter(written, { tags: ['d'] })).toBe(
			'tags:\n  # my tags\n  - d\nzip: 02134\n'
		);
		expect(
			writeFrontmatter('tags: # fill me in\n# about zip\nzip: 02134\n', { tags: ['c'] })
		).toBe('tags:\n  # fill me in\n  - c\n# about zip\nzip: 02134\n');
	});

	it('keeps the comments of a block whose last key it deletes', () => {
		const written = writeFrontmatter('# top\ntitle: a\n# bottom\n', { title: undefined });
		expect(written).toBe('# top\n# bottom\n{}\n');
		expect(splitFrontmatter(joinFrontmatter(written, 'body\n'))).toEqual({
			frontmatter: '# top\n# bottom\n{}',
			body: 'body\n',
		});
	});
});

/**
 * The same questions, asked of blocks nobody thought of. Seeded, so a failure
 * is the same failure on every machine, and names the seed it came from.
 */
describe('writeFrontmatter, over blocks put together at random', () => {
	// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
	const mulberry32 = (seed: number): (() => number) => {
		let state = seed;
		return () => {
			state = (state + 0x6d2b79f5) | 0;
			const a = Math.imul(state ^ (state >>> 15), 1 | state);
			const b = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
			return ((b ^ (b >>> 14)) >>> 0) / 4294967296;
		};
	};

	/** Ways a file spells each key; `null` is the key left out. */
	const SPELLINGS: Readonly<Record<string, readonly (string | null)[]>> = {
		id: [null, 'id: abc', 'id: "abc"', 'id: 0123 # mine', 'id:'],
		title: [
			null,
			'title: Old',
			"title: 'Old' # named",
			'title:',
			'title: # todo',
			'title: 007',
		],
		created: [null, 'created: 2024-09-14', 'created: last spring', 'created:'],
		updated: [null, 'updated: 2025-01-01', 'updated: whenever'],
		tags: [
			null,
			'tags: [a,b] # mine',
			'tags:\n    - a\n    - b',
			'tags:\n- a',
			'tags: a, b',
			'tags:',
		],
		zip: [null, 'zip: 02134', 'zip: 02134 # boston'],
		mask: [null, 'mask: 0x1F'],
		big: [null, 'big: 12345678901234567890'],
		aliases: [null, 'aliases: [one,two]', 'aliases:\n- one\n- two'],
		geo: [null, 'geo: {lat: 1,lon: 2}'],
		empty: [null, 'empty:', 'empty: ~'],
		text: [null, 'text: |\n  one\n\n  two', 'text: >-\n  folded\n  twice'],
		kept: [null, 'kept: |+\n  keep'],
	};
	const PATCHES: Readonly<Record<string, readonly unknown[]>> = {
		id: ['abc', 'uuid'],
		title: ['Old', 'New', 'New: two', undefined],
		created: ['2024-09-14T00:00:00.000Z', '2020-01-01T00:00:00.000Z'],
		updated: ['2025-01-01T00:00:00.000Z', '2026-03-01T10:00:00.000Z'],
		tags: [['a', 'b'], ['c'], undefined],
	};
	const FILLER = ['', '', '# a note to self', '#another'];

	interface Case {
		readonly block: string;
		readonly patch: Record<string, unknown>;
		/** The source of each pair the patch does not name. */
		readonly untouched: readonly string[];
		readonly comments: readonly string[];
	}

	const caseFrom = (seed: number): Case => {
		const random = mulberry32(seed);
		const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
		const pairs = Object.entries(SPELLINGS)
			.map(([key, spellings]) => ({ key, source: pick(spellings), order: random() }))
			.filter((pair): pair is typeof pair & { source: string } => pair.source !== null)
			.sort((a, b) => a.order - b.order);
		const patch = Object.fromEntries(
			Object.entries(PATCHES)
				.filter(() => random() < 0.5)
				.map(([key, values]) => [key, pick(values)])
		);
		const lines = pairs.flatMap(({ source }) => [
			...(random() < 0.6 ? [] : [pick(FILLER)]),
			source,
		]);
		const block = [...lines, ...(random() < 0.3 ? [pick(FILLER)] : [])].join('\n');
		return {
			block: random() < 0.5 ? block : `${block}\n`,
			patch,
			untouched: pairs.filter(({ key }) => !(key in patch)).map(({ source }) => source),
			comments: lines.filter((line) => line.startsWith('#')),
		};
	};

	const valuesOf = (yaml: string): Record<string, unknown> =>
		(parseDocument(yaml).toJS() ?? {}) as Record<string, unknown>;

	it('writes what was asked and nothing else, and writes it once', () => {
		Array.from({ length: 400 }, (_, seed) => seed).forEach((seed) => {
			const { block, patch, untouched, comments } = caseFrom(seed);
			if (block.trim() === '') return;
			// `undefined` spelled out: it is the half of a patch JSON leaves unsaid.
			const asked = JSON.stringify(patch, (_, value: unknown) => value ?? '(deleted)');
			const about = `seed ${String(seed)}: ${JSON.stringify(block)} + ${asked}`;
			const written = writeFrontmatter(block, patch);

			expect(parseDocument(written).errors, about).toEqual([]);

			// Every key the patch does not name means what it meant.
			const before = valuesOf(block);
			const after = valuesOf(written);
			Object.keys(before)
				.filter((key) => !(key in patch))
				.forEach((key) => expect(after[key], `${key}, ${about}`).toEqual(before[key]));

			// What the patch names reads back — except over an `id` or a `created`
			// the app declines, which stay the user's.
			const read = readFrontmatter(written);
			const was = readFrontmatter(block);
			if ('title' in patch) expect(read.title, about).toBe(patch.title);
			if ('tags' in patch) expect(read.tags, about).toEqual(patch.tags);
			if ('updated' in patch) {
				expect(Date.parse(read.updated ?? ''), about).toBe(
					Date.parse(patch.updated as string)
				);
			}
			if ('id' in patch && typeof before.id !== 'number')
				expect(read.id, about).toBe(patch.id);
			if (
				'created' in patch &&
				(was.created === undefined || was.created !== 'last spring')
			) {
				expect(Date.parse(read.created ?? ''), about).toBe(
					Date.parse(patch.created as string)
				);
			}

			// The bytes of every pair the patch does not name, and every comment
			// on a line of its own, which is nobody's to move. The one exception
			// is a block that had to be written whole, as every block once was —
			// respelled, and a deleted key's comment gone with it — and the only
			// way into that from here is a pair deleted under a scalar that keeps
			// its blank lines.
			const whole = block.includes('|+') && Object.values(patch).includes(undefined);
			if (!whole) {
				const linesOut = written.split('\n');
				comments.forEach((comment) => expect(linesOut, about).toContain(comment));
				untouched.forEach((source) =>
					expect(`${written}\n`, about).toContain(`${source}\n`)
				);
			}

			expect(writeFrontmatter(written, patch), `again, ${about}`).toBe(written);
		});
	});
});
