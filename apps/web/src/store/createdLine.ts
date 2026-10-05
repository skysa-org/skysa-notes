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
 * reads such lines differently in each engine and not at all in some: the
 * line is the note's date if, a time of day aside, every word in it is the
 * year, month or day the note was made — the month by number or by name — or
 * the name of a weekday, and all three are there. Names are asked of the
 * reader's languages and of English, which is what OneNote writes in for most
 * people. The day is the one the note was made in this time zone or in UTC,
 * since an exporter may have written either.
 *
 * A note the file gave no date for is dated by when it was read in, which no
 * line of it names, so nothing of it is passed over.
 */

/**
 * A time of day: `2:00 PM`, `14:00`, `14:00:10`, `9.30 a.m.`, after `at` or not.
 * With a dot only before am or pm, since `02.20.2014` is a date.
 */
const TIME =
	/\b(?:at\s+)?\d{1,2}(?::\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\b\.?)?|\.\d{2}\s*[ap]\.?\s?m\b\.?)/gi;

const WORD = /[\p{L}\p{N}]+/gu;

const names = (locale: string, at: Date, options: Intl.DateTimeFormatOptions): string[] => {
	try {
		return [new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at)];
	} catch {
		return [];
	}
};

/** The words of `text`, lowercased, a number without its leading zeros. */
const wordsOf = (text: string): string[] =>
	(text.toLocaleLowerCase().match(WORD) ?? []).map((word) => word.replace(/^0+(?=\d)/, ''));

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

/** The words of every weekday's name, long and short, in `locale`. 2024-01-01 was a Monday. */
const weekdays = (locale: string): readonly string[] =>
	remembered(`weekdays:${locale}`, () =>
		Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2024, 0, 1 + day))).flatMap(
			(at) => [
				...names(locale, at, { weekday: 'long' }),
				...names(locale, at, { weekday: 'short' }),
			]
		)
	);

/** The words of a month's name, long and short, in `locale`. */
const months = (locale: string, month: number): readonly string[] =>
	remembered(`month:${locale}:${String(month)}`, () => {
		const at = new Date(Date.UTC(2024, month, 15));
		return [...names(locale, at, { month: 'long' }), ...names(locale, at, { month: 'short' })];
	});

/** One day the note may be dated by: its year, month and day as words. */
interface Day {
	year: string;
	month: Set<string>;
	day: string;
}

const dayOf = (year: number, month: number, day: number, locales: readonly string[]): Day => ({
	year: String(year),
	month: new Set([String(month + 1), ...locales.flatMap((locale) => months(locale, month))]),
	day: String(day),
});

const READER_LOCALES = (): readonly string[] =>
	typeof navigator === 'undefined' ? [] : navigator.languages;

/**
 * Whether every word is `day`'s or a weekday's, and the whole of `day` is
 * there: its year, its day, and its month as a word of its own — on the 2nd of
 * February, `2014-02-02` has a `2` for each, and `2014-02` has one for only one.
 */
const saysDay = (words: readonly string[], day: Day, weekdayWords: ReadonlySet<string>): boolean =>
	words.every(
		(word) =>
			word === day.year || word === day.day || day.month.has(word) || weekdayWords.has(word)
	) &&
	words.includes(day.year) &&
	words.includes(day.day) &&
	(words.some((word) => word !== day.day && day.month.has(word)) ||
		words.filter((word) => word === day.day).length > 1);

export const isCreatedLine = (
	line: string | undefined,
	createdAt: number,
	locales: readonly string[] = [...READER_LOCALES(), 'en']
): boolean => {
	if (line === undefined || !Number.isFinite(createdAt)) return false;
	const words = wordsOf(line.replaceAll(TIME, ' '));
	if (words.length < 3) return false;
	const at = new Date(createdAt);
	const days = [
		dayOf(at.getFullYear(), at.getMonth(), at.getDate(), locales),
		dayOf(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), locales),
	];
	const weekdayWords = new Set(locales.flatMap(weekdays));
	return days.some((day) => saysDay(words, day, weekdayWords));
};
