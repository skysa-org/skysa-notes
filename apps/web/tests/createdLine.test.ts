import { describe, expect, it } from 'vitest';

import { isCreatedLine } from '../src/store/createdLine.js';

const MADE = Date.UTC(2014, 1, 20, 14, 0, 10);

describe('isCreatedLine', () => {
	it("reads OneNote's line under the title as the note's date", () => {
		expect(isCreatedLine('Thursday, February 20, 2014 2:00 PM', MADE, ['en'])).toBe(true);
		expect(isCreatedLine('Thursday, February 20, 2014', MADE, ['en'])).toBe(true);
	});

	it('reads the other ways a date is written', () => {
		[
			'2014-02-20',
			'20/02/2014',
			'02.20.2014 14:00',
			'Feb 20, 2014 at 9.30 a.m.',
			'20 February 2014, 14:00:10',
			'Thu 20 Feb 2014',
		].forEach((line) => {
			expect(isCreatedLine(line, MADE, ['en']), line).toBe(true);
		});
	});

	it("reads names in the reader's language", () => {
		expect(isCreatedLine('jeudi 20 février 2014 14:00', MADE, ['fr'])).toBe(true);
		expect(isCreatedLine('jeudi 20 février 2014 14:00', MADE, ['en'])).toBe(false);
	});

	it('reads a day whose number is its month’s too', () => {
		const second = Date.UTC(2014, 1, 2, 12);
		expect(isCreatedLine('2014-02-02', second, ['en'])).toBe(true);
		expect(isCreatedLine('2014-02', second, ['en'])).toBe(false);
	});

	it('takes the day in this time zone or in UTC, as an exporter may have written either', () => {
		const lateUtc = Date.UTC(2014, 1, 20, 23, 30);
		const local = new Date(lateUtc);
		const localLine = `${String(local.getFullYear())}-${String(local.getMonth() + 1)}-${String(local.getDate())}`;
		expect(isCreatedLine('2014-02-20', lateUtc, ['en'])).toBe(true);
		expect(isCreatedLine(localLine, lateUtc, ['en'])).toBe(true);
	});

	it('leaves any line that says more than the date, or another date', () => {
		[
			'Thursday, February 20, 2014: the meeting',
			'Notes from February 20, 2014',
			'Thursday, February 21, 2014',
			'February 2014',
			'20 2014',
			'',
		].forEach((line) => {
			expect(isCreatedLine(line, MADE, ['en']), line).toBe(false);
		});
		expect(isCreatedLine(undefined, MADE, ['en'])).toBe(false);
		expect(isCreatedLine('2014-02-20', Number.NaN, ['en'])).toBe(false);
	});
});
