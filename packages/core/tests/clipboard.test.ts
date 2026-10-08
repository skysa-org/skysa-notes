import { describe, expect, it } from 'vitest';

import { clipName, clipPath, clipStamp, isClipPath, readClipName } from '../src/clipboard.js';

const HASH = '3f9a1c2b5d6e7f80';
const AT = Date.UTC(2026, 9, 6, 15, 30, 12, 123);

describe('clipName', () => {
	it('stamps a text with when it was pasted', () => {
		expect(clipName({ at: AT, hash: HASH, text: true })).toBe(
			'20261006T153012123Z-text-3f9a1c2b.txt'
		);
	});

	it('calls a picture from the clipboard a pasted image', () => {
		expect(
			clipName({ at: AT, hash: HASH, name: 'image.png', type: 'image/png', pasted: true })
		).toBe('20261006T153012123Z-pasted-image-3f9a1c2b.png');
	});

	it('keeps a file’s own name, as a slug', () => {
		expect(clipName({ at: AT, hash: HASH, name: 'Q3 Report.PDF' })).toBe(
			'20261006T153012123Z-q3-report-3f9a1c2b.pdf'
		);
	});

	it('keeps .md, which is no note in the hidden folder', () => {
		expect(clipName({ at: AT, hash: HASH, name: 'Minutes.md' })).toBe(
			'20261006T153012123Z-minutes-3f9a1c2b.md'
		);
	});

	it('names a file without a name by its type', () => {
		expect(clipName({ at: AT, hash: HASH, name: '', type: 'application/pdf' })).toBe(
			'20261006T153012123Z-attachment-3f9a1c2b.pdf'
		);
	});
});

describe('readClipName', () => {
	it('reads back what clipName wrote', () => {
		expect(readClipName(clipName({ at: AT, hash: HASH, text: true }))).toEqual({
			at: AT,
			hash: '3f9a1c2b',
			kind: 'text',
			label: undefined,
		});
		expect(
			readClipName(
				clipName({ at: AT, hash: HASH, name: 'x.png', type: 'image/png', pasted: true })
			)
		).toEqual({ at: AT, hash: '3f9a1c2b', kind: 'image', label: undefined });
		expect(readClipName(clipName({ at: AT, hash: HASH, name: 'Holiday.JPG' }))).toEqual({
			at: AT,
			hash: '3f9a1c2b',
			kind: 'image',
			label: 'holiday.jpg',
		});
		expect(readClipName(clipName({ at: AT, hash: HASH, name: 'Q3 report.pdf' }))).toEqual({
			at: AT,
			hash: '3f9a1c2b',
			kind: 'file',
			label: 'q3-report.pdf',
		});
	});

	it('takes the last hex run for the hash', () => {
		expect(readClipName('20261006T153012123Z-build-deadbeef-3f9a1c2b.zip')).toMatchObject({
			hash: '3f9a1c2b',
			label: 'build-deadbeef.zip',
		});
	});

	it('makes a card of an SVG, which is never drawn from a blob: URL', () => {
		expect(readClipName('20261006T153012123Z-logo-3f9a1c2b.svg')?.kind).toBe('file');
	});

	it('leaves alone a name the app did not write', () => {
		for (const name of [
			'notes.txt',
			'20261006T153012123Z-text.txt',
			'20261006T153012123Z-text-3f9a1c2.txt',
			'20261006T153012123Z-text-3F9A1C2B.txt',
			'20261306T153012123Z-text-3f9a1c2b.txt',
			'20261006T253012123Z-text-3f9a1c2b.txt',
			'20261006T153012123Z-text-3f9a1c2b (conflict 2026-10-06T15-30).txt',
		]) {
			expect(readClipName(name), name).toBeUndefined();
		}
	});
});

describe('clipStamp', () => {
	it('is now, or just after the newest item if that is later', () => {
		expect(clipStamp(1000, undefined)).toBe(1000);
		expect(clipStamp(1000, 400)).toBe(1000);
		expect(clipStamp(1000, 5000)).toBe(5001);
		expect(clipStamp(1000, 1000)).toBe(1001);
	});
});

describe('the folder', () => {
	it('is where every item is, and counts as the clipboard’s itself', () => {
		expect(clipPath('a.txt')).toBe('.clipboard/a.txt');
		expect(isClipPath('.clipboard')).toBe(true);
		expect(isClipPath('.clipboard/a.txt')).toBe(true);
		expect(isClipPath('.clipboards/a.txt')).toBe(false);
		expect(isClipPath('Work/.clipboard/a.txt')).toBe(false);
	});
});
