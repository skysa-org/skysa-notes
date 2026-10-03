import { describe, expect, it } from 'vitest';

import {
	contentTypeOf,
	downloadName,
	drawsFromData,
	fileKind,
	fileKindLabel,
	opensInTab,
	safeOpenType,
	showsInline,
} from '../src/attachments.js';

describe('fileKind', () => {
	it.each([
		['holiday.JPG', 'image'],
		['scan.pdf', 'pdf'],
		['letter.docx', 'document'],
		['notes.txt', 'text'],
		['budget.xlsx', 'spreadsheet'],
		['data.csv', 'spreadsheet'],
		['deck.key', 'presentation'],
		['backup.tar.gz', 'archive'],
		['voice.m4a', 'audio'],
		['clip.mov', 'video'],
		['config.json', 'code'],
		['page.html', 'code'],
		['mystery.qqq', 'file'],
		['README', 'file'],
	])('%s is %s', (name, kind) => {
		expect(fileKind(name)).toBe(kind);
	});

	it('has a label for every kind', () => {
		expect(fileKindLabel('pdf')).toBe('PDF');
		expect(fileKindLabel('file')).toBe('File');
	});
});

describe('showsInline', () => {
	it.each([
		['a.png', true],
		['a.jpeg', true],
		['a.GIF', true],
		['a.webp', true],
		['a.avif', true],
		['a.svg', true],
		['a.bmp', true],
		// Images, but not ones most browsers can draw: a chip, not a blank.
		['a.heic', false],
		['a.tiff', false],
		['a.pdf', false],
	])('%s → %s', (name, expected) => {
		expect(showsInline(name)).toBe(expected);
	});
});

describe('safeOpenType', () => {
	it.each([
		['a.png', 'image/png'],
		['a.JPG', 'image/jpeg'],
		['a.pdf', 'application/pdf'],
		['a.mp4', 'video/mp4'],
		['a.mp3', 'audio/mpeg'],
	])('opens %s as %s', (name, type) => {
		expect(safeOpenType(name)).toBe(type);
		expect(opensInTab(name)).toBe(true);
	});

	it.each([
		// Each of these is a document that runs script when opened, and a blob
		// URL would run it as this app.
		'a.svg',
		'a.SVG',
		'a.html',
		'a.htm',
		'a.xhtml',
		'a.xml',
		'a.js',
		'a.mjs',
		// And the rest, whatever they are: downloaded, never shown.
		'a.txt',
		'a.docx',
		'a',
		'a.png.html',
		'a.svgz',
		'a.xht',
		'a.xsl',
		'a.mht',
		'a.shtml',
		'a.wasm',
	])('never opens %s, only downloads it', (name) => {
		expect(safeOpenType(name)).toBe('application/octet-stream');
		expect(opensInTab(name)).toBe(false);
	});

	it('opens nothing as a type outside the allowlist', () => {
		// The whole of what may open in a tab. Anything added here is a type a
		// browser shows in this origin, and has to be one that runs nothing.
		const allowed = new Set([
			'image/png',
			'image/jpeg',
			'image/gif',
			'image/webp',
			'image/avif',
			'image/bmp',
			'application/pdf',
			'audio/mpeg',
			'audio/mp4',
			'audio/wav',
			'audio/ogg',
			'video/mp4',
			'video/webm',
			'application/octet-stream',
		]);
		const extensions = [
			...'png jpg jpeg gif webp avif svg svgz bmp heic heif tif tiff ico cur'.split(' '),
			...'pdf doc docx odt rtf pages epub txt log markdown md rst org'.split(' '),
			...'xls xlsx ods csv tsv numbers ppt pptx odp key zip tar gz tgz bz2 xz 7z rar'.split(
				' '
			),
			...'mp3 m4a aac wav flac ogg oga opus mp4 m4v mov webm mkv avi ogv'.split(' '),
			...'json yaml yml toml xml xsl xslt xht xhtml html htm shtml mht mhtml'.split(' '),
			...'css js mjs cjs ts wasm swf rdf vtt py rb go rs java c h cpp sh sql'.split(' '),
		];
		const opened = new Set(extensions.map((extension) => safeOpenType(`a.${extension}`)));

		expect([...opened].filter((type) => !allowed.has(type))).toEqual([]);
		expect([...opened].filter((type) => /svg|xml|html|script/.test(type))).toEqual([]);
	});
});

describe('contentTypeOf', () => {
	it.each([
		['a.png', 'image/png'],
		['a.JPG', 'image/jpeg'],
		// Told to the provider, for its own preview; never what this origin
		// opens it as (`safeOpenType`).
		['a.svg', 'image/svg+xml'],
		['a.heic', 'image/heic'],
		['a.pdf', 'application/pdf'],
		['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
		['a.qqq', undefined],
		['a.html', undefined],
		['README', undefined],
	])('%s → %s', (name, type) => {
		expect(contentTypeOf(name)).toBe(type);
	});
});

describe('drawsFromData', () => {
	it.each([
		['a.svg', true],
		['a.SVG', true],
		['a.png', false],
		['a.pdf', false],
	])('%s → %s', (name, expected) => {
		expect(drawsFromData(name)).toBe(expected);
	});
});

describe('downloadName', () => {
	it.each([
		['Q3 report.pdf', 'q3-report-3f9a1c2b.pdf', 'Q3 report.pdf'],
		['Q3 report', 'q3-report-3f9a1c2b.pdf', 'q3-report-3f9a1c2b.pdf'],
		['Q3 report.PDF', 'q3-report-3f9a1c2b.pdf', 'Q3 report.PDF'],
		['../../etc/passwd.pdf', 'a-3f9a1c2b.pdf', 'etc passwd.pdf'],
		['a/b\\c:d.pdf', 'a-3f9a1c2b.pdf', 'a b c d.pdf'],
		['.hidden.pdf', 'a-3f9a1c2b.pdf', 'hidden.pdf'],
		['', 'a-3f9a1c2b.pdf', 'a-3f9a1c2b.pdf'],
		// Shown as `Invoice exe.pdf`, and saved as an `.exe`, were the control
		// kept.
		['Invoice \u202efdp.exe', 'invoice-3f9a1c2b.exe', 'Invoice fdp.exe'],
		['a\ud800b.pdf', 'a-3f9a1c2b.pdf', 'ab.pdf'],
		['', '.hidden', 'hidden'],
		['', '...', 'attachment'],
	])('%j for %s → %j', (label, stored, name) => {
		expect(downloadName(label, stored)).toBe(name);
	});

	it('cuts a long name to what a filesystem takes, keeping its extension', () => {
		const name = downloadName(`${'写'.repeat(400)}.pdf`, 'a-3f9a1c2b.pdf');
		expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
		expect(name).toMatch(/^写+\.pdf$/u);
	});
});
