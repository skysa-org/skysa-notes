/**
 * Whether a line of a note says nothing but when the note was made.
 *
 * OneNote puts one under every page's title — `Thursday, February 20, 2014
 * 2:00 PM` — and so does every exporter of it, and many a journal template. In
 * a note's row it is the whole preview: the row has room for a line, and that
 * line repeats the date the note list already sorts by. So the preview passes
 * over it, as it passes over the title (`NoteList`'s `preview`).
 *
 * Read as the words it is made of rather than as a date, since `Date.parse`
 * reads such lines differently in each engine and not at all in some. Once at
 * most one time of day is taken out, the line is the note's date if:
 *
 * - its numbers are the year, month and day the note was made, each once — the
 *   month may be a name instead — and in that order where the year comes first,
 *   so `2014-03-02` is not the 3rd of February;
 * - every other word is that month's name, a weekday's, or one a language puts
 *   between the parts of a date (`de`, `den`, `г`, `年`), or an ordinal's end;
 * - and nothing else is left but the punctuation a date is written with: a
 *   `$`, a `×` or a second time of day is something the user wrote.
 *
 * Names are asked of the reader's languages and of English, which is what
 * OneNote writes in for most people. The day is the one the note was made in
 * this time zone or in UTC, since an exporter may have written either.
 *
 * A note the file gave no date for is dated by when it was read in, which no
 * line of it names, so nothing of it is passed over.
 */

/**
 * A time of day: `2:00 PM`, `14:00`, `14:00:10`, `9.30 a.m.`, `2 PM`,
 * `14h00`, after `at` or not. With a dot only before am or pm, since
 * `02.20.2014` is a date.
 */
const AM_PM = String.raw`\s?[ap]\.?\s?m\b\.?`;
const TIME = new RegExp(
	String.raw`\b(?:at\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d(?::[0-5]\d)?(?:${AM_PM})?|h[0-5]\d\b|\.[0-5]\d${AM_PM}|${AM_PM})`,
	'gi'
);

/** Runs of digits and runs of letters, apart: `2014年2月20日` is six words. */
const WORD = /\p{N}+|\p{L}+/gu;

/** What may stand between the words of a date, and nothing else may. */
const DATE_PUNCTUATION = /^[\s,./\-–—()·、،]*$/u;

/** A full date is not long; a line that is runs to more than a date. */
const LONGEST = 80;

const ORDINAL_ENDS = ['st', 'nd', 'rd', 'th'];

/** The words of `text`, lowercased, a number without its leading zeros. */
const wordsOf = (text: string): string[] =>
	(text.toLocaleLowerCase().match(WORD) ?? []).map((word) => word.replace(/^0+(?=\d)/, ''));

const formatter = (locale: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat(locale, {
		...options,
		timeZone: 'UTC',
		calendar: 'gregory',
		numberingSystem: 'latn',
	});

/** The parts a date is written with, of `type` or all, or none for a locale that will not say. */
const partsOf = (
	locale: string,
	at: Date,
	options: Intl.DateTimeFormatOptions,
	type?: Intl.DateTimeFormatPartTypes
): string[] => {
	try {
		const parts = formatter(locale, options).formatToParts(at);
		return parts
			.filter((part) => type === undefined || part.type === type)
			.map((part) => part.value);
	} catch {
		return [];
	}
};

/**
 * Names, kept once made: a list of a thousand notes asks for them a thousand
 * times a render, and a formatter is not cheap to make.
 */
const named = new Map<string, readonly string[]>();
const remembered = (key: string, make: () => string[]): readonly string[] => {
	const known = named.get(key);
	if (known !== undefined) return known;
	const made = make().flatMap(wordsOf);
	named.set(key, made);
	return made;
};

const STYLES = ['full', 'long', 'medium'] as const;

/** The words of every weekday's name, long and short, in `locale`. 2024-01-01 was a Monday. */
const weekdays = (locale: string): readonly string[] =>
	remembered(`weekdays:${locale}`, () =>
		Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2024, 0, 1 + day))).flatMap(
			(at) => [
				...partsOf(locale, at, { weekday: 'long' }),
				...partsOf(locale, at, { weekday: 'short' }),
			]
		)
	);

/**
 * The words `locale` writes between the parts of a date, and before its time:
 * `de`, `den`, `г`, `年`, `um`, `at`. And its words for morning and afternoon
 * (`下午`, `오후`), which go with a time of day.
 */
const literals = (locale: string): readonly string[] =>
	remembered(`literals:${locale}`, () => {
		const at = new Date(Date.UTC(2024, 0, 2, 2));
		const afternoon = new Date(Date.UTC(2024, 0, 2, 14));
		return [
			...STYLES.flatMap((dateStyle) => [
				...partsOf(locale, at, { dateStyle }, 'literal'),
				...partsOf(locale, at, { dateStyle, timeStyle: 'short' }, 'literal'),
			]),
			...[at, afternoon].flatMap((time) =>
				partsOf(locale, time, { timeStyle: 'short', hour12: true }, 'dayPeriod')
			),
		];
	});

/**
 * The words of a month's name in `locale`: alone, and as a date spells it,
 * which in many languages is another form (`февраль` alone, `февраля` in a
 * date).
 */
const months = (locale: string, month: number): readonly string[] =>
	remembered(`month:${locale}:${String(month)}`, () => {
		const at = new Date(Date.UTC(2024, month, 15));
		return [
			...partsOf(locale, at, { month: 'long' }),
			...partsOf(locale, at, { month: 'short' }),
			...STYLES.flatMap((dateStyle) => partsOf(locale, at, { dateStyle }, 'month')),
		];
	});

/** The words a line of a date may hold beside its numbers and its month, per set of languages. */
const fillers = new Map<string, ReadonlySet<string>>();
const fillerWords = (locales: readonly string[]): ReadonlySet<string> => {
	const key = locales.join(',');
	const known = fillers.get(key);
	if (known !== undefined) return known;
	const made = new Set([
		...ORDINAL_ENDS,
		...locales.flatMap(weekdays),
		...locales.flatMap(literals),
	]);
	fillers.set(key, made);
	return made;
};

const isNumber = (word: string): boolean => /^\d+$/.test(word);

/** One day the note may be dated by: its year, month and day as words. */
interface Day {
	year: string;
	month: string;
	day: string;
	monthNames: ReadonlySet<string>;
}

/**
 * The day in words. A month's name is its letters, and not the ones a date
 * puts around any month: Japanese names February `2月`, which is the number
 * and the `月` every month has.
 */
const dayOf = (
	[year, month, day]: readonly [number, number, number],
	locales: readonly string[],
	fill: ReadonlySet<string>
): Day => ({
	year: String(year),
	month: String(month + 1),
	day: String(day),
	monthNames: new Set(
		locales
			.flatMap((locale) => months(locale, month))
			.filter((word) => !isNumber(word) && !fill.has(word))
	),
});

const sameNumbers = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/** Whether `words` are `day`'s, each part once, and the year first only before its month and day. */
const saysDay = (words: readonly string[], day: Day, fill: ReadonlySet<string>): boolean => {
	const numbers = words.filter(isNumber);
	const others = words.filter((word) => !isNumber(word));
	const monthNamed = others.filter((word) => day.monthNames.has(word));
	if (monthNamed.length > 1) return false;
	if (!others.every((word) => day.monthNames.has(word) || fill.has(word))) return false;
	const wanted = monthNamed.length === 1 ? [day.year, day.day] : [day.year, day.month, day.day];
	if (!sameNumbers(numbers, wanted)) return false;
	return numbers[0] !== day.year || numbers.join(' ') === wanted.join(' ');
};

const READER_LOCALES = (): readonly string[] =>
	typeof navigator === 'undefined' ? [] : navigator.languages;

/** Whether a line is a time of day and nothing more, as an exporter may put under the date. */
export const isTimeLine = (line: string | undefined): boolean =>
	line !== undefined &&
	(line.match(TIME) ?? []).length === 1 &&
	DATE_PUNCTUATION.test(line.replaceAll(TIME, ''));

export const isCreatedLine = (
	line: string | undefined,
	createdAt: number,
	locales: readonly string[] = [...READER_LOCALES(), 'en']
): boolean => {
	if (line === undefined || line.length > LONGEST || !Number.isFinite(createdAt)) return false;
	if ((line.match(TIME) ?? []).length > 1) return false;
	const undated = line.replaceAll(TIME, ' ');
	if (!DATE_PUNCTUATION.test(undated.replaceAll(WORD, ''))) return false;
	const words = wordsOf(undated);
	if (words.filter(isNumber).length < 2) return false;
	const at = new Date(createdAt);
	const fill = fillerWords(locales);
	const days: (readonly [number, number, number])[] = [
		[at.getFullYear(), at.getMonth(), at.getDate()],
		[at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()],
	];
	return days.some((day) => saysDay(words, dayOf(day, locales, fill), fill));
};
