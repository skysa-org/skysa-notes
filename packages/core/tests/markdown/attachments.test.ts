import { readFileSync } from 'node:fs';

import type { Image, Link, Paragraph } from 'mdast';
import { describe, expect, it } from 'vitest';

import { bytesHash } from '../../src/hash.js';
import {
	attachmentHref,
	attachmentLabel,
	attachmentMarkdown,
	classifyHref,
	extensionOf,
	isAttachmentHref,
	linkedFiles,
	MAX_ATTACHMENT_BYTES,
	resolveRelative,
} from '../../src/markdown/attachments.js';
import { parse } from '../../src/markdown/pipeline.js';
import { attachmentName } from '../../src/markdown/slug.js';
import { conflictNameKeepingExtension } from '../../src/sync/conflicts.js';

const HASH = '3f9a1c2b7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8';
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('MAX_ATTACHMENT_BYTES', () => {
	it('is 25 MiB', () => {
		expect(MAX_ATTACHMENT_BYTES).toBe(26_214_400);
	});
});

describe('extensionOf', () => {
	it.each([
		['photo.png', 'png'],
		['Photo.PNG', 'png'],
		['archive.tar.gz', 'gz'],
		['a..png', 'png'],
		['.env', ''],
		['README', ''],
		['minutes.2026-01-01 with the board', ''],
		['name.waytoolongtobeanextension', ''],
		['folder.v2/readme', ''],
		['folder.v2\\readme', ''],
	])('%s → %s', (name, extension) => {
		expect(extensionOf(name)).toBe(extension);
	});

	it('agrees with the conflict namer about where the extension starts', () => {
		for (const name of ['photo.png', 'a..png', '.env', 'archive.tar.gz', 'x.İmd']) {
			const renamed = conflictNameKeepingExtension(name, new Date(0));
			expect(extensionOf(renamed)).toBe(extensionOf(name));
		}
	});
});

describe('classifyHref', () => {
	it.each([
		['photo.png', 'relative'],
		['./photo.png', 'relative'],
		['../Work/a b.pdf', 'relative'],
		['%E5%86%99%E7%9C%9F.png', 'relative'],
		['写真.png', 'relative'],
		['https://example.com/a.png', 'https'],
		['HTTPS://example.com/a.png', 'https'],
		['data:image/png;base64,AAAA', 'data'],
		['http://example.com/a.png', 'other'],
		['javascript:alert(1)', 'other'],
		['file:///etc/passwd', 'other'],
		['blob:https://app/1', 'other'],
		['/abs/a.png', 'other'],
		['//host/a.png', 'other'],
		['#heading', 'other'],
		['?q=1', 'other'],
		['a.pdf#page=2', 'other'],
		['a\\b.png', 'other'],
		['', 'other'],
		// As a browser's URL parser reads it, which drops what is around a URL
		// and every tab and newline in it.
		['\tjavascript:alert(1)', 'other'],
		['java\tscript:alert(1)', 'other'],
		['java\nscript:alert(1)', 'other'],
		['\u0000javascript:alert(1)', 'other'],
		[' https://example.com/a.png', 'https'],
		[' photo.png ', 'relative'],
	])('%j is %s', (href, kind) => {
		expect(classifyHref(href)).toBe(kind);
	});
});

describe('isAttachmentHref', () => {
	it.each([
		['photo.png', true],
		['sub/scan.pdf', true],
		['a%20b.pdf', true],
		['other-note.md', false],
		['Other-Note.MD', false],
		['folder', false],
		['.hidden', false],
		['https://example.com/a.pdf', false],
		['#a.png', false],
		['a%20b/100%.pdf', true],
		// Judged by the name each segment decodes to, once the destination is
		// split: an escaped separator does not make a note or a folder a file.
		['x.md%2F', false],
		['X.MD%2F', false],
		['sub/x.md%2F%2F', false],
		['folder.v2%2F', false],
		['a%2Fb.png', false],
		['a%5Cb.png', false],
		['a%00.png', false],
		['a/', false],
		['a/..', false],
	])('%s → %s', (href, expected) => {
		expect(isAttachmentHref(href)).toBe(expected);
	});
});

describe('resolveRelative', () => {
	it.each([
		['note.md', 'photo.png', 'photo.png'],
		['Work/note.md', 'photo.png', 'Work/photo.png'],
		['Work/note.md', './photo.png', 'Work/photo.png'],
		['Work/note.md', '../photo.png', 'photo.png'],
		['Work/Q3/note.md', '../../x/./y.pdf', 'x/y.pdf'],
		['Work/note.md', 'a%20b.pdf', 'Work/a b.pdf'],
		['Work/note.md', '100%.pdf', 'Work/100%.pdf'],
		['Work/note.md', 'a//b.png', 'Work/a/b.png'],
		['Work/note.md', 'a%20b/100%.pdf', 'Work/a b/100%.pdf'],
		// An escaped `..` is a `..`, as it is to a browser.
		['Work/note.md', '%2e%2e/a.png', 'a.png'],
	])('%s + %s → %s', (note, href, path) => {
		expect(resolveRelative(note, href)).toBe(path);
	});

	it.each([
		// Climbing past the app folder names nothing in it — not, as
		// `normalizePath` would make of it, a file at the top.
		['note.md', '../photo.png'],
		['Work/note.md', '../../etc/a.png'],
		['Work/note.md', 'a/../../../b.png'],
		['note.md', '.'],
		['note.md', 'https://example.com/a.png'],
		['note.md', '/a.png'],
		['note.md', 'a\\b.png'],
		// Escaped, the same climbs, and what no file's name holds.
		['Work/note.md', '%2e%2e/%2e%2e/%2e%2e/etc/a.png'],
		['Work/note.md', '..%2F..%2F..%2Fa.png'],
		['Work/note.md', 'a%5C..%5C..%5Cb.png'],
		['Work/note.md', 'a%2Fb.png'],
		['Work/note.md', 'a%00.png'],
		// A folder, not a file.
		['Work/note.md', 'a/'],
		['Work/note.md', 'a/..'],
		['Work/note.md', 'x.md%2F'],
	])('%s + %s → nothing', (note, href) => {
		expect(resolveRelative(note, href)).toBeUndefined();
	});
});

describe('attachmentName', () => {
	it('is the slug of the name, the hash, and the extension', () => {
		expect(attachmentName({ name: 'Q3 Report.PDF', hash: HASH })).toBe(
			'q3-report-3f9a1c2b.pdf'
		);
	});

	it('calls a picture from the clipboard what it is', () => {
		expect(attachmentName({ name: 'image.png', hash: HASH, pasted: true })).toBe(
			'pasted-image-3f9a1c2b.png'
		);
	});

	it('takes the extension from the type where the name has none', () => {
		expect(attachmentName({ name: 'image', hash: HASH, type: 'image/jpeg' })).toBe(
			'image-3f9a1c2b.jpg'
		);
		expect(attachmentName({ name: '', hash: HASH, type: 'image/png; q=1' })).toBe(
			'attachment-3f9a1c2b.png'
		);
		expect(attachmentName({ name: 'blob', hash: HASH, type: 'application/x-what' })).toBe(
			'blob-3f9a1c2b.bin'
		);
	});

	it('takes the type over an extension that is not letters and digits', () => {
		expect(attachmentName({ name: 'scan.p$f', hash: HASH, type: 'application/pdf' })).toBe(
			'scan-3f9a1c2b.pdf'
		);
	});

	it('keeps a name in any script, and never starts with a dot', () => {
		expect(attachmentName({ name: '写真 2026.JPG', hash: HASH })).toBe(
			'写真-2026-3f9a1c2b.jpg'
		);
		expect(attachmentName({ name: '.env', hash: HASH, type: 'text/plain' })).toBe(
			'env-3f9a1c2b.txt'
		);
	});

	it('keeps the name of a pasted file that is not a picture', () => {
		expect(attachmentName({ name: 'Q3 report.pdf', hash: HASH, pasted: true })).toBe(
			'q3-report-3f9a1c2b.pdf'
		);
		expect(attachmentName({ name: 'image.JPEG', hash: HASH, pasted: true })).toBe(
			'pasted-image-3f9a1c2b.jpeg'
		);
	});

	it.each([
		[{ hash: 'ABC/../x' }],
		[{ hash: '3f9a1c2' }],
		[{ hash: HASH, hashLength: 7 }],
		[{ hash: HASH, hashLength: 17 }],
		[{ hash: HASH, hashLength: 64 }],
		[{ hash: HASH, hashLength: 8.5 }],
		[{ hash: '3f9a1c2b', hashLength: 16 }],
	])('refuses a hash that is not 8 to 16 hex: %o', (input) => {
		expect(() => attachmentName({ name: 'a.png', ...input })).toThrow(RangeError);
	});

	it('uses a longer hash when asked to', () => {
		expect(attachmentName({ name: 'a.png', hash: HASH, hashLength: 16 })).toBe(
			'a-3f9a1c2b7d4e5f60.png'
		);
	});

	it('refuses a note, however it is spelled', () => {
		expect(attachmentName({ name: 'notes.md', hash: HASH })).toBeUndefined();
		expect(attachmentName({ name: 'NOTES.MD', hash: HASH })).toBeUndefined();
	});

	it('leaves room for a conflict suffix inside the 255 bytes a name may have', () => {
		const name = attachmentName({
			name: `${'写'.repeat(200)}.abcdefghijklmnop`,
			hash: HASH,
			hashLength: 16,
		})!;
		const copy = conflictNameKeepingExtension(name, new Date(0), [name]);
		expect(copy).toMatch(
			/^写+-3f9a1c2b7d4e5f60 \(conflict 1970-01-01T00-00\)\.abcdefghijklmnop$/u
		);
		expect(
			utf8Bytes(`${copy.replace(/\.[^.]+$/u, '')}-999.abcdefghijklmnop`)
		).toBeLessThanOrEqual(255);
	});

	it('is the same name for the same bytes', async () => {
		const bytes = new TextEncoder().encode('the same picture');
		const once = attachmentName({ name: 'a.png', hash: await bytesHash(bytes) });
		const again = attachmentName({ name: 'a.png', hash: await bytesHash(bytes.slice()) });
		expect(once).toBe(again);
	});
});

describe('bytesHash', () => {
	it('is SHA-256 in lowercase hex', async () => {
		expect(await bytesHash(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('attachmentHref', () => {
	it('is the name itself for a name the app made', () => {
		for (const name of ['q3-report-3f9a1c2b.pdf', '写真-2026-3f9a1c2b.jpg']) {
			expect(attachmentHref(name)).toBe(name);
		}
	});

	it('escapes what a destination cannot hold, and resolves back to the name', () => {
		const name = 'Q3 (final) #2 100%.pdf';
		const href = attachmentHref(name);
		expect(href).toBe('Q3%20%28final%29%20%232%20100%25.pdf');
		expect(resolveRelative('Work/note.md', href)).toBe(`Work/${name}`);
		expect(isAttachmentHref(href)).toBe(true);
	});

	it.each(['a:b.pdf', 'c:report.pdf', 'https:x.png'])(
		'keeps %j a file beside the note, not a link somewhere else',
		(name) => {
			const href = attachmentHref(name);
			expect(classifyHref(href)).toBe('relative');
			expect(resolveRelative('Work/note.md', href)).toBe(`Work/${name}`);
		}
	);
});

describe('attachmentLabel', () => {
	it.each([
		[{ name: 'Holiday.JPG', kind: 'image' as const }, 'Holiday'],
		[{ name: 'image.png', kind: 'image' as const, pasted: true }, 'Pasted image'],
		[{ name: '.png', kind: 'image' as const }, '.png'],
		[{ name: '', kind: 'image' as const }, 'Image'],
		[{ name: 'Q3 report.pdf', kind: 'file' as const }, 'Q3 report.pdf'],
		[{ name: 'a\u0000b.pdf', kind: 'file' as const }, 'a b.pdf'],
		[{ name: '  ', kind: 'file' as const }, 'Attachment'],
		[{ name: 'a\ud800b.pdf', kind: 'file' as const }, 'a b.pdf'],
	])('%o → %s', (input, label) => {
		expect(attachmentLabel(input)).toBe(label);
	});

	it('says what the caller gives it, where the name gives nothing', () => {
		const words = { pastedImage: 'Eingefügtes Bild', image: 'Bild', file: 'Anhang' };
		expect(attachmentLabel({ name: 'image.png', kind: 'image', pasted: true, words })).toBe(
			'Eingefügtes Bild'
		);
		expect(attachmentLabel({ name: '', kind: 'image', words })).toBe('Bild');
		expect(attachmentLabel({ name: '  ', kind: 'file', words })).toBe('Anhang');
		expect(attachmentLabel({ name: 'Holiday.JPG', kind: 'image', words })).toBe('Holiday');
	});
});

describe('attachmentMarkdown', () => {
	const only = (markdown: string) =>
		(parse(markdown).children[0] as Paragraph).children[0] as Image | Link;

	it('writes an image and a file as ordinary markdown', () => {
		expect(
			attachmentMarkdown({ label: 'Holiday', href: 'holiday-3f9a1c2b.jpg', kind: 'image' })
		).toBe('![Holiday](holiday-3f9a1c2b.jpg)');
		expect(
			attachmentMarkdown({
				label: 'Q3 report.pdf',
				href: 'q3-report-3f9a1c2b.pdf',
				kind: 'file',
			})
		).toBe('[Q3 report.pdf](q3-report-3f9a1c2b.pdf)');
	});

	it.each([
		['a ] bracket', 'a.png'],
		['*not emphasis*', 'a.png'],
		['back\\slash', 'a b.png'],
		['[x](y)', 'a%20b.png'],
	])('reads back as exactly the label %s and the destination %s', (label, href) => {
		const image = only(attachmentMarkdown({ label, href, kind: 'image' })) as Image;
		expect(image).toMatchObject({ type: 'image', alt: label, url: href });

		const link = only(attachmentMarkdown({ label, href, kind: 'file' })) as Link;
		expect(link.type).toBe('link');
		expect(link.url).toBe(href);
		expect(link.children).toEqual([expect.objectContaining({ type: 'text', value: label })]);
	});

	it('keeps a label with a line break in it to one link', () => {
		for (const kind of ['image', 'file'] as const) {
			const markdown = attachmentMarkdown({ label: 'a\n\nb\u0000c', href: 'a.png', kind });
			expect(parse(markdown).children).toHaveLength(1);
			expect(only(markdown).type).toBe(kind === 'image' ? 'image' : 'link');
		}
	});
});

describe('linkedFiles', () => {
	it('finds images, links, references and raw <img>, each once, in order', () => {
		const body = [
			'![Holiday](holiday.jpg) and [Q3](q3.pdf "Q3")',
			'',
			'[ref][r] and ![again](holiday.jpg)',
			'',
			'<img src="diagram.svg" alt="d">',
			"<p><img alt='x' src='sub/chart.png'></p>",
			'',
			'[r]: ref.zip',
		].join('\n');

		expect(linkedFiles(body, 'Work/note.md')).toEqual([
			'Work/holiday.jpg',
			'Work/q3.pdf',
			'Work/diagram.svg',
			'Work/sub/chart.png',
			'Work/ref.zip',
		]);
	});

	it('leaves out notes, the web, the root, hidden files and code', () => {
		const body = [
			'[a note](other.md) [web](https://example.com/a.pdf) ![d](data:image/png;base64,AA)',
			'[up and out](../../a.pdf) [marker](.notesapp.json) [hidden](.cache/a.png)',
			'',
			'```',
			'![in code](code.png)',
			'```',
			'',
			'`![inline code](inline.png)`',
		].join('\n');

		expect(linkedFiles(body, 'Work/note.md')).toEqual([]);
	});

	it('finds every file in the round-trip fixture', () => {
		const fixture = readFileSync(new URL('fixtures/attachments.md', import.meta.url), 'utf8');

		expect(linkedFiles(fixture, 'Trips/notes.md')).toEqual([
			'Trips/pasted-image-3f9a1c2b.png',
			'Trips/itinerary-5d2e8a10.pdf',
			'Trips/receipts 2026.zip',
			'Trips/sub/map-77aa01ff.jpg',
			'Trips/q3-report-0b1c2d3e.pdf',
			'Trips/emphasised-1a2b3c4d.pdf',
			'Trips/a b.pdf',
			'Trips/diagram-0c0c0c0c.svg',
		]);
	});

	it('reads raw <img> as a browser does', () => {
		const body = [
			'<img alt="x src=evil.png" src="real.png">',
			'<img alt="a -> b" src="gt.png">',
			'<img src=" spaced.png ">',
			'<IMG SRC=upper.png>',
			'<img src="a&amp;b.png"> <img src="&#99;&#x64;.png">',
			'<img alt="no source">',
			'<!-- <img src="commented.png"> -->',
			'<!-- unclosed <img src="after.png">',
		].join('\n');

		expect(linkedFiles(body, 'note.md')).toEqual([
			'real.png',
			'gt.png',
			'spaced.png',
			'upper.png',
			'a&b.png',
			'cd.png',
		]);
	});

	it('reads raw HTML in time that grows with it, not with its square', () => {
		// Unclosed tags, each of which a pattern that read on to the next `>`
		// would read to the end from.
		const body = `<div>\n${'<img a '.repeat(100_000)}`;
		const started = performance.now();
		expect(linkedFiles(body, 'note.md')).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it('leaves out a link to a note or a folder written with an escaped separator', () => {
		const body = '[x](x.md%2F) [y](folder.v2%2F) ![z](a%5C..%5C..%5Cb.png) ![n](a%00.png)';
		expect(linkedFiles(body, 'Work/note.md')).toEqual([]);
	});

	it('reads a destination written in angle brackets or with escapes as the same file', () => {
		const body = '[a](<a b.pdf>) [b](a%20b.pdf) [c](a\\(b.pdf)';
		expect(linkedFiles(body, 'note.md')).toEqual(['a b.pdf', 'a(b.pdf']);
	});
});
