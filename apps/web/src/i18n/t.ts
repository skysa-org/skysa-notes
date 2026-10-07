import {
	type Args,
	type At,
	type Catalog,
	isPlural,
	type Keys,
	type Message,
	type ParamValue,
} from './catalog.js';
import { en } from './en/index.js';

/**
 * The app's words, looked up by key (docs/ARCHITECTURE.md §7, "The app's
 * words").
 *
 * English is the only catalog so far. The locale is settled once, when the
 * page loads, and never changes under a running page: a language chosen later
 * would be a reload, so nothing here has to tell React that the words moved.
 */

export type English = typeof en;

export type MessageKey = Keys<English>;

/** The language the words are in, which is also what numbers and plurals follow. */
export const LOCALE = 'en';

const catalog: Catalog = en;

const numbers = new Intl.NumberFormat(LOCALE);
const plurals = new Intl.PluralRules(LOCALE);

const PLACEHOLDER = /\{(\w+)\}/g;

type Values = Readonly<Record<string, ParamValue>>;

/** The message a key names, unfilled: for `rich()`, which fills it piece by piece. */
export const messageAt = (key: string): Message => {
	const found = key
		.split('.')
		.reduce<Message | Catalog | undefined>(
			(node, part) =>
				node === undefined || typeof node === 'string' || isPlural(node)
					? undefined
					: node[part],
			catalog
		);
	// Unreachable while the key is typed, and a missing word is not worth
	// taking the screen down for: the key says where to look.
	if (found === undefined || (typeof found === 'object' && !isPlural(found))) return key;
	return found;
};

/** The words for a message: the plural's form for `count`, if it counts. */
export const choose = (message: Message, values: Values): string => {
	if (typeof message === 'string') return message;
	const count = values.count;
	return message[plurals.select(typeof count === 'number' ? count : 0)] ?? message.other;
};

/** The placeholders filled: a number in the locale's digits, a string as it is. */
export const fill = (text: string, values: Values): string =>
	text.replace(PLACEHOLDER, (whole, name: string) => {
		if (!Object.hasOwn(values, name)) return whole;
		const value = values[name];
		return typeof value === 'number' ? numbers.format(value) : String(value);
	});

/** The message `key` names, in the user's language, with its placeholders filled. */
export const t = <K extends MessageKey>(key: K, ...args: Args<At<English, K>>): string => {
	const values: Values = args[0] ?? {};
	return fill(choose(messageAt(key), values), values);
};
