import { describe, expect, it } from 'vitest';

import {
	downloadName,
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
	])('never opens %s, only downloads it', (name) => {
		expect(safeOpenType(name)).toBe('application/octet-stream');
		expect(opensInTab(name)).toBe(false);
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
	])('%s for %s → %s', (label, stored, name) => {
		expect(downloadName(label, stored)).toBe(name);
	});
});
