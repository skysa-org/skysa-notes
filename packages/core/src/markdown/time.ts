/**
 * A time as a note's frontmatter spells it, read the same in every browser.
 *
 * `Date.parse` was the reader, and engines disagree about everything but the
 * one form ECMAScript pins down (`2014-02-20T14:00:10Z`). The form tools
 * export most — OneNote's exporters, SQL dumps, a date and a time with a space
 * between — is one of the disagreements: Chromium and Firefox read
 * `2014-02-20 14:00:10 UTC`, and WebKit, which is Safari and every browser on
 * an iPhone, answers `NaN`. A note whose `created` cannot be read is dated by
 * when it was read in, so a library of ten years' notes, imported, sorted as
 * if all of it had been written that day, and only on some devices.
 *
 * So the date-and-time forms are read here, by one rule: a date, optionally a
 * time after a `T` or a space, optionally a zone (`Z`, `UTC`, `GMT` or an
 * offset). A date alone is midnight UTC and a time with no zone is local time,
 * as ECMAScript reads the ISO forms, so a value every engine already agreed on
 * reads as it always did. Anything else — `Feb 20, 2014`, an RFC 2822 date, a
 * date with an offset and no time — is still handed to `Date.parse`. What the
 * rule reads and refuses stays refused: a day the month does not have
 * (`2014-02-30`, which V8 rolls into March), an hour of 24, an offset past
 * ±23:59.
 *
 * Never `NaN`: a value that is not a time answers `undefined`, and the caller
 * decides what stands in for it. `NaN` in a timestamp is not a wrong date but
 * a comparator that answers false both ways, and the note list sorts on these.
 */

const STAMP =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Minutes east of UTC that a zone names; `Z`, `UTC` and `GMT` are none, and
 * an offset past ±23:59 is no offset.
 */
const offsetOf = (zone: string): number | undefined => {
	if (!/^[+-]/.test(zone)) return 0;
	const digits = zone.slice(1).replace(':', '');
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2) || '0');
	if (hours > 23 || minutes > 59) return undefined;
	return (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
};

interface Parts {
	year: number;
	month: number;
	day: number;
	hours: number;
	minutes: number;
	seconds: number;
	ms: number;
}

/**
 * Whether the month has the day: `2014-02-30` is no date, where `Date` would
 * roll it into March. Asked in UTC, which has no gaps, so a local time that a
 * clock change skips — 23:30 on a night the clocks go from 23:00 to midnight —
 * is the time the engine makes of it rather than no time at all.
 */
const hasDay = (parts: Parts): boolean => {
	const at = new Date(0);
	at.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	return at.getUTCDate() === parts.day;
};

/**
 * The instant those parts name, in UTC or in local time. Set field by field
 * rather than through `Date.UTC` or the constructor, both of which read a year
 * under 100 as 1900 and up.
 */
const instant = (parts: Parts, utc: boolean): number => {
	const at = new Date(0);
	if (utc) {
		at.setUTCFullYear(parts.year, parts.month - 1, parts.day);
		at.setUTCHours(parts.hours, parts.minutes, parts.seconds, parts.ms);
	} else {
		at.setFullYear(parts.year, parts.month - 1, parts.day);
		at.setHours(parts.hours, parts.minutes, parts.seconds, parts.ms);
	}
	return at.getTime();
};

const fromStamp = (match: RegExpExecArray): number | undefined => {
	const [, year, month, day, hours, minutes, seconds, fraction, zone] = match;
	const parts: Parts = {
		year: Number(year),
		month: Number(month),
		day: Number(day),
		hours: Number(hours ?? 0),
		minutes: Number(minutes ?? 0),
		seconds: Number(seconds ?? 0),
		ms: Number((fraction ?? '').slice(0, 3).padEnd(3, '0')),
	};
	if (parts.month < 1 || parts.month > 12 || parts.day < 1 || !hasDay(parts)) return undefined;
	if (parts.hours > 23 || parts.minutes > 59 || parts.seconds > 59) return undefined;
	if (zone === undefined) return instant(parts, hours === undefined);
	const offset = offsetOf(zone);
	return offset === undefined ? undefined : instant(parts, true) - offset * 60_000;
};

/** The instant `text` names, or undefined when it names none. */
export const readTime = (text: string): number | undefined => {
	const trimmed = text.trim();
	const match = STAMP.exec(trimmed);
	// A date and an offset with no time between them (`2014-02-20-05`) is not
	// a form this reads; what an engine makes of it is up to the engine.
	const dateAndOffset = match?.[4] === undefined && /^[+-]/.test(match?.[8] ?? '');
	if (match !== null && !dateAndOffset) return fromStamp(match);
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
};
