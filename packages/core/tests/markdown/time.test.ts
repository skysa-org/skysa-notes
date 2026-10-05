import { describe, expect, it } from 'vitest';

import { readTime } from '../../src/markdown/time.js';

describe('readTime', () => {
	it('reads a date and a time with a space between, which WebKit cannot', () => {
		expect(readTime('2014-02-20 14:00:10 UTC')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10));
		expect(readTime('2014-02-20 14:00:10 GMT')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10));
		expect(readTime('2014-02-20 14:00:10Z')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10));
	});

	it('reads the ISO forms as ECMAScript does', () => {
		[
			'2026-09-14T13:02:11Z',
			'2026-09-14T13:02:11.250Z',
			'2026-09-14T13:02:11+02:00',
			'2026-09-14T13:02:11-0530',
			'2026-09-14T13:02',
			'2026-09-14T13:02:11',
			'2026-09-14',
		].forEach((text) => {
			expect(readTime(text), text).toBe(Date.parse(text));
		});
	});

	it('reads an offset written after a space', () => {
		expect(readTime('2014-02-20 14:00:10 +01:00')).toBe(Date.UTC(2014, 1, 20, 13, 0, 10));
		expect(readTime('2014-02-20 14:00 -05')).toBe(Date.UTC(2014, 1, 20, 19, 0));
	});

	it('reads a time with no zone as local time, and a date alone as UTC', () => {
		expect(readTime('2014-02-20 14:00:10')).toBe(new Date(2014, 1, 20, 14, 0, 10).getTime());
		expect(readTime('2014-02-20')).toBe(Date.UTC(2014, 1, 20));
	});

	it('reads a fraction of a second to the millisecond', () => {
		expect(readTime('2014-02-20T14:00:10.123456Z')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10, 123));
		expect(readTime('2014-02-20 14:00:10,5 UTC')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10, 500));
	});

	it('reads a year before 100 as itself', () => {
		const at = new Date(0);
		at.setUTCFullYear(42, 0, 1);
		expect(readTime('0042-01-01')).toBe(at.getTime());
	});

	it('answers nothing for a day, month or time that does not exist', () => {
		[
			'2014-02-30',
			'2014-13-01',
			'2014-00-10',
			'2014-02-20 24:00:00Z',
			'2014-02-20 14:60Z',
		].forEach((text) => {
			expect(readTime(text), text).toBeUndefined();
		});
	});

	it('hands any other spelling to the engine, and answers nothing for no time at all', () => {
		expect(readTime('Thu, 20 Feb 2014 14:00:10 GMT')).toBe(Date.UTC(2014, 1, 20, 14, 0, 10));
		expect(readTime('last spring')).toBeUndefined();
		expect(readTime('')).toBeUndefined();
	});
});
