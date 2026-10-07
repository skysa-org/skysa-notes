/**
 * What a catalog of the app's words is made of (docs/ARCHITECTURE.md §7,
 * "The app's words").
 *
 * Plain data, the shape a translation platform reads as JSON: a message is a
 * string, or one string per plural category when it counts something, and
 * messages are grouped in namespaces by the part of the app that says them. No
 * functions, so a translator never has to write code, and nothing compiled at
 * runtime, which the Content-Security-Policy would refuse (§9).
 *
 * - **Placeholders** are `{name}`, filled from the call's params: a number is
 *   written in the catalog's locale, a string as it is.
 * - **Plurals** are `{ one, other }`, or whichever of the CLDR categories the
 *   language has (https://cldr.unicode.org/index/cldr-spec/plural-rules),
 *   picked by `Intl.PluralRules` from the `count` param. `other` is always
 *   there. Each one is a whole sentence: English's "it" and "them", "was" and
 *   "were", are the translator's to choose, never the code's.
 * - **Rich text** is `<name>…</name>` around the words a tag wraps, rendered by
 *   `rich()` with a function per tag. Not nested.
 *
 * A namespace may not have a key named after a plural category, since an object
 * with `other` in it is a plural.
 */

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export interface Plural {
	readonly zero?: string;
	readonly one?: string;
	readonly two?: string;
	readonly few?: string;
	readonly many?: string;
	readonly other: string;
}

export type Message = string | Plural;

export interface Catalog {
	readonly [key: string]: Message | Catalog;
}

export const isPlural = (node: Message | Catalog): node is Plural =>
	typeof node === 'object' && typeof node.other === 'string';

/**
 * A catalog in another language: every key the English one has, each a string
 * or a plural as there, with words of its own.
 */
export type Translation<C> = {
	readonly [K in keyof C]: C[K] extends string
		? string
		: C[K] extends Plural
			? Plural
			: Translation<C[K]>;
};

/** Every message's key, as the dotted path to it: `'common.cancel'`. */
export type Keys<C, Prefix extends string = ''> = {
	[K in keyof C & string]: C[K] extends Message ? `${Prefix}${K}` : Keys<C[K], `${Prefix}${K}.`>;
}[keyof C & string];

/** The message a key names. */
export type At<C, K extends string> = K extends `${infer Head}.${infer Rest}`
	? Head extends keyof C
		? At<C[Head], Rest>
		: never
	: K extends keyof C
		? C[K]
		: never;

/** A message's words: the string, or each of a plural's. */
export type Texts<M> = M extends Plural ? Exclude<M[keyof M], undefined> : M;

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
	? Name | Placeholders<Rest>
	: never;

/** The tags a rich message wraps words in. */
export type Tags<S> = S extends `${string}<${infer Name}>${infer Rest}`
	? Name extends `/${string}`
		? Tags<Rest>
		: Name | Tags<Rest>
	: never;

export type ParamValue = string | number;

/** What a message has to be given: its placeholders, and `count` for a plural. */
export type Params<M> = (M extends Plural ? Readonly<{ count: number }> : unknown) & {
	readonly [N in Placeholders<Texts<M>>]: N extends 'count' ? number : ParamValue;
};

/** No params argument for a message that takes none, and a required one otherwise. */
export type Args<M> = [Placeholders<Texts<M>> | (M extends Plural ? 'count' : never)] extends [
	never,
]
	? []
	: [params: Params<M>];
