import { describe, expect, it } from 'vitest';

import { isCreatedLine, isTimeLine } from '../src/store/createdLine.js';

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

	it('reads the forms other languages write a date in', () => {
		[
			['es', 'jueves, 20 de febrero de 2014'],
			['pt-BR', 'quinta-feira, 20 de fevereiro de 2014'],
			['ru', '20 февраля 2014 г.'],
			['pl', '20 lutego 2014'],
			['de', 'Donnerstag, 20. Februar 2014 um 14:00'],
			['da', 'torsdag den 20. februar 2014'],
			['ja', '2014年2月20日'],
			['ko', '2014년 2월 20일'],
		].forEach(([locale = '', line]) => {
			expect(isCreatedLine(line, MADE, [locale, 'en']), `${locale}: ${String(line)}`).toBe(
				true
			);
		});
		expect(isCreatedLine('20 de febrero de 2014 fui', MADE, ['es', 'en'])).toBe(false);
	});

	it('reads the times and ordinals a template writes', () => {
		[
			'Thursday, February 20th, 2014',
			'February 20, 2014 2 PM',
			'20 February 2014 14h00',
		].forEach((line) => {
			expect(isCreatedLine(line, MADE, ['en']), line).toBe(true);
		});
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
			// The day's numbers, but other things than a date made of them.
			'$20 – Feb 2014',
			'20 × 2 = 2014',
			'-20 °, 2 Feb 2014',
			'2014-20-20',
			'20 20 2014',
			'2014-02-20 / 2014-02-02',
			'Feb 20 – Feb 2, 2014',
			// The month and day the other way round, the year first.
			'2014-20-02',
			// A second time is an event, not when the note was made.
			'Thursday, February 20, 2014 7:00 PM - 11:30 PM',
			'Thursday, February 20, 2014: the meeting',
			'Notes from February 20, 2014',
			// Days enough away that no time zone makes them the note's.
			'Sunday, February 23, 2014',
			'February 2014',
			'20 2014',
			'',
		].forEach((line) => {
			expect(isCreatedLine(line, MADE, ['en']), line).toBe(false);
		});
		expect(isCreatedLine(undefined, MADE, ['en'])).toBe(false);
		expect(isCreatedLine('2014-02-20', Number.NaN, ['en'])).toBe(false);
	});

	it('reads ISO order as year, month, day, and another order either way', () => {
		const third = Date.UTC(2014, 1, 3, 12);
		expect(isCreatedLine('2014-02-03', third, ['en'])).toBe(true);
		expect(isCreatedLine('2014-03-02', third, ['en'])).toBe(false);
		expect(isCreatedLine('03/02/2014', third, ['en'])).toBe(true);
		expect(isCreatedLine('02/03/2014', third, ['en'])).toBe(true);
	});

	it('knows a line that is only a time of day', () => {
		expect(isTimeLine('2:00 PM')).toBe(true);
		expect(isTimeLine('14:00')).toBe(true);
		expect(isTimeLine('2:00 PM - 3:00 PM')).toBe(false);
		expect(isTimeLine('Lunch at 2:00 PM')).toBe(false);
		expect(isTimeLine(undefined)).toBe(false);
	});
});
