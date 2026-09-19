import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	noteFilename,
	sanitizeFolderName,
	slugify,
	uniqueFilename,
} from '../../src/markdown/slug.js';
import { deriveTitle, titleFromFilename } from '../../src/markdown/title.js';

/** Both caps in `slug.ts`, and the property a provider adapter needs of a name. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const expectSafeName = (name: string): void => {
	expect(() => encodeURIComponent(name)).not.toThrow();
	expect([...name].length).toBeLessThanOrEqual(120);
	expect(utf8Bytes(name)).toBeLessThanOrEqual(216);
};

const PARTY = '\u{1f389}';
/** Man, woman, girl, joined: five code points and eight UTF-16 units, one character. */
const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
/** `e` with a combining acute and a combining dot below, which NFC cannot compose away. */
const STACKED = 'e\u0323\u0301\u0316';

describe('slugify', () => {
	it('lowercases and hyphenates', () => {
		expect(slugify('2026 Q3 Planning')).toBe('2026-q3-planning');
	});

	it('collapses runs of separators', () => {
		expect(slugify('a   b__c...d')).toBe('a-b-c-d');
	});

	it('strips characters providers or filesystems reject', () => {
		expect(slugify('why/how: "when"?')).toBe('why-how-when');
	});

	it('keeps non-Latin scripts rather than emptying the name', () => {
		expect(slugify('日本語のノート')).toBe('日本語のノート');
		expect(slugify('Заметка')).toBe('заметка');
	});

	it('never starts with a dot, which would hide the file', () => {
		expect(slugify('.hidden')).toBe('hidden');
		expect(slugify('...')).toBe('untitled');
	});

	it('never ends with a dot or space, which Windows strips silently', () => {
		expect(slugify('trailing dot.')).toBe('trailing-dot');
		expect(slugify('trailing space ')).toBe('trailing-space');
	});

	it('falls back for a title with nothing usable in it', () => {
		expect(slugify('')).toBe('untitled');
		expect(slugify('   ')).toBe('untitled');
		expect(slugify('***')).toBe('untitled');
	});

	it('sidesteps Windows device names', () => {
		expect(slugify('CON')).toBe('con-note');
		expect(slugify('com1')).toBe('com1-note');
		expect(slugify('console')).toBe('console');
	});

	it('caps length, leaving room for a conflict suffix', () => {
		const slug = slugify('x'.repeat(400));
		expect(slug.length).toBeLessThanOrEqual(120);
	});

	it('does not leave a trailing hyphen after truncation', () => {
		expect(slugify(`${'a'.repeat(119)} tail`)).not.toMatch(/-$/);
	});

	it('strips control characters', () => {
		expect(slugify('a\u0000b\u001fc')).toBe('a-b-c');
	});

	it('sidesteps the device names OneDrive refuses and the superscript digits Windows reads', () => {
		expect(slugify('COM0')).toBe('com0-note');
		expect(slugify('lpt0')).toBe('lpt0-note');
		expect(slugify('COM\u00b9')).toBe('com\u00b9-note');
		expect(slugify('LPT\u00b3')).toBe('lpt\u00b3-note');
		expect(slugify('com10')).toBe('com10');
	});

	describe('truncation', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('does not cut an astral character in half', () => {
			// 119 units, then a surrogate pair straddling unit 120.
			const slug = slugify(`${'a'.repeat(119)}${PARTY}`);
			expectSafeName(slug);
			expect(slug).toBe(`${'a'.repeat(119)}${PARTY}`);
			expect(slugify(`${'a'.repeat(120)}${PARTY}`)).toBe('a'.repeat(120));
		});

		it('does not cut a joined emoji into a different one', () => {
			const slug = slugify(`${'a'.repeat(118)}${FAMILY}`);
			expectSafeName(slug);
			expect(slug).toBe('a'.repeat(118));
			expect(slugify(`${'a'.repeat(115)}${FAMILY}`)).toBe(`${'a'.repeat(115)}${FAMILY}`);
		});

		it('does not strand a letter without its combining marks', () => {
			const slug = slugify(`${'a'.repeat(118)}${STACKED}`);
			expectSafeName(slug);
			expect(slug).toBe('a'.repeat(118));
		});

		it('caps a CJK title by bytes, which is what a filesystem counts', () => {
			const slug = slugify('\u65e5'.repeat(120));
			expectSafeName(slug);
			expect(slug).toBe('\u65e5'.repeat(72));
			// Room for both counters, the conflict suffix and the extension in 255.
			expect(utf8Bytes(`${slug}-999 (conflict 2026-09-18T20-58)-999.md`)).toBeLessThanOrEqual(
				255
			);
		});

		it('drops a lone surrogate the title arrived with', () => {
			const slug = slugify('broken \ud83c title');
			expectSafeName(slug);
			expect(slug).toBe('broken-title');
		});

		it('keeps something of a name that is one enormous cluster', () => {
			const slug = slugify(`z${'\u0301'.repeat(300)}`);
			expectSafeName(slug);
			// NFC folds the first mark into the letter; the other 299 stay marks.
			expect(slug.startsWith('\u017a\u0301')).toBe(true);
		});

		it('holds all of that where there is no Intl.Segmenter', () => {
			vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
			const names = [
				slugify(`${'a'.repeat(119)}${PARTY}`),
				slugify(`${'a'.repeat(118)}${FAMILY}`),
				slugify(`${'a'.repeat(118)}${STACKED}`),
				slugify('\u65e5'.repeat(120)),
			];
			names.forEach(expectSafeName);
			expect(names[1]).toBe('a'.repeat(118));
			expect(names[2]).toBe('a'.repeat(118));
		});
	});
});

describe('noteFilename', () => {
	it('appends the markdown extension', () => {
		expect(noteFilename('Reading List')).toBe('reading-list.md');
	});
});

describe('uniqueFilename', () => {
	it('uses the plain name when nothing collides', () => {
		expect(uniqueFilename('Notes', [])).toBe('notes.md');
	});

	it('suffixes on collision, the way a file manager does', () => {
		expect(uniqueFilename('Notes', ['notes.md'])).toBe('notes-2.md');
		expect(uniqueFilename('Notes', ['notes.md', 'notes-2.md'])).toBe('notes-3.md');
	});

	it('compares case-insensitively, as Drive, Dropbox and macOS do', () => {
		expect(uniqueFilename('Notes', ['NOTES.MD'])).toBe('notes-2.md');
	});

	it('ignores unrelated names', () => {
		expect(uniqueFilename('Notes', ['other.md', 'notebook.md'])).toBe('notes.md');
	});
});

describe('titleFromFilename', () => {
	it('drops the extension and restores spaces', () => {
		expect(titleFromFilename('2026-q3-planning.md')).toBe('2026 q3 planning');
	});

	it('leaves a name with no extension alone', () => {
		expect(titleFromFilename('scratch')).toBe('scratch');
	});
});

describe('deriveTitle', () => {
	it('prefers frontmatter title', () => {
		expect(
			deriveTitle({
				frontmatterTitle: 'From Frontmatter',
				body: '# From Heading\n',
				filename: 'from-filename.md',
			})
		).toBe('From Frontmatter');
	});

	it('falls back to the first heading', () => {
		expect(deriveTitle({ body: '# From Heading\n', filename: 'from-filename.md' })).toBe(
			'From Heading'
		);
	});

	it('takes the first heading at any level', () => {
		expect(deriveTitle({ body: 'Intro text.\n\n## Second Level\n' })).toBe('Second Level');
	});

	it('reads through inline formatting in the heading', () => {
		expect(deriveTitle({ body: '# A *fancy* `title`\n' })).toBe('A fancy title');
	});

	it('falls back to the filename when there is no heading', () => {
		expect(deriveTitle({ body: 'Just prose.\n', filename: 'quick-thought.md' })).toBe(
			'quick thought'
		);
	});

	it('ignores an empty frontmatter title', () => {
		expect(deriveTitle({ frontmatterTitle: '   ', body: '# Real Title\n' })).toBe('Real Title');
	});

	it('ignores an empty heading', () => {
		expect(deriveTitle({ body: '#\n\nProse.\n', filename: 'fallback.md' })).toBe('fallback');
	});

	it('has a last resort', () => {
		expect(deriveTitle({})).toBe('Untitled');
		expect(deriveTitle({ body: 'No heading here.\n' })).toBe('Untitled');
	});
});

describe('sanitizeFolderName', () => {
	it('keeps the name the user typed', () => {
		expect(sanitizeFolderName('Work Notes')).toBe('Work Notes');
		expect(sanitizeFolderName('2026 Q3')).toBe('2026 Q3');
	});

	it('removes only what would break a path', () => {
		expect(sanitizeFolderName('Q3 / Q4: plans?')).toBe('Q3 Q4 plans');
	});

	it('collapses the whitespace it leaves behind', () => {
		expect(sanitizeFolderName('a  \t b')).toBe('a b');
	});

	it('never starts with a dot, which would hide the folder', () => {
		expect(sanitizeFolderName('.git')).toBe('git');
	});

	it('never ends with a dot or space, which Windows strips silently', () => {
		expect(sanitizeFolderName('Notes. ')).toBe('Notes');
	});

	it('falls back for a name with nothing usable in it', () => {
		expect(sanitizeFolderName('')).toBe('Untitled');
		expect(sanitizeFolderName('///')).toBe('Untitled');
	});

	it('sidesteps Windows device names', () => {
		expect(sanitizeFolderName('CON')).toBe('CON folder');
	});

	it('caps length', () => {
		expect(sanitizeFolderName('x'.repeat(400)).length).toBeLessThanOrEqual(120);
	});

	it('caps without cutting a character in half, and by bytes', () => {
		[
			`${'A'.repeat(119)}${PARTY}`,
			`${'A'.repeat(118)}${FAMILY}`,
			`${'A'.repeat(118)}${STACKED}`,
			'\u65e5'.repeat(120),
			'lone \udc00 half',
		].forEach((name) => {
			expectSafeName(sanitizeFolderName(name));
		});
		expect(sanitizeFolderName(`${'A'.repeat(118)}${FAMILY}`)).toBe('A'.repeat(118));
	});

	it('does not end in a dot or a space the cut exposed', () => {
		expect(sanitizeFolderName(`${'A'.repeat(119)}. tail`)).toBe('A'.repeat(119));
	});

	it('sidesteps COM0, LPT0 and the superscript digits', () => {
		expect(sanitizeFolderName('LPT0')).toBe('LPT0 folder');
		expect(sanitizeFolderName('COM\u00b2')).toBe('COM\u00b2 folder');
	});
});
