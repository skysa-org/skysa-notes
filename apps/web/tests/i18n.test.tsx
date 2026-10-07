import { render } from '@testing-library/react';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	type Args,
	type Catalog,
	isPlural,
	type Message,
	PLURAL_CATEGORIES,
} from '../src/i18n/catalog.js';
import { en } from '../src/i18n/en/index.js';
import { markup, rich } from '../src/i18n/rich.js';
import { choose, fill, messageAt, t } from '../src/i18n/t.js';

/**
 * The app's words (docs/ARCHITECTURE.md §7, "The app's words"): how a key
 * becomes text, and what every message in the catalog has to be for that to
 * work in a language other than English.
 */

const messages = (node: Catalog, path: string): [string, Message][] =>
	Object.entries(node).flatMap(([key, value]): [string, Message][] => {
		const at = path === '' ? key : `${path}.${key}`;
		if (typeof value === 'string' || isPlural(value)) return [[at, value]];
		return messages(value, at);
	});

const ALL = messages(en, '');

const textsOf = (message: Message): string[] =>
	typeof message === 'string'
		? [message]
		: PLURAL_CATEGORIES.flatMap((category) => message[category] ?? []);

describe('t', () => {
	it('is the message a key names', () => {
		expect(t('common.cancel')).toBe('Cancel');
	});

	it('fills a placeholder with what it is given, and leaves one it is not given as written', () => {
		expect(t('shell.palette.noMatch', { query: 'zip' })).toBe('Nothing matches “zip”.');
		expect(fill('{a} and {b}', { a: 'one' })).toBe('one and {b}');
	});

	it('writes a number in the locale, and a string as it is', () => {
		expect(fill('{n} notes', { n: 1028 })).toBe('1,028 notes');
		expect(fill('In {year}', { year: '2026' })).toBe('In 2026');
	});

	it('does not read a placeholder out of the prototype', () => {
		expect(fill('{constructor}', {})).toBe('{constructor}');
	});

	it('picks the plural form the count asks for, and other where the language has no such form', () => {
		const notes = { one: '{count} note', other: '{count} notes' };
		expect(fill(choose(notes, { count: 1 }), { count: 1 })).toBe('1 note');
		expect(fill(choose(notes, { count: 0 }), { count: 0 })).toBe('0 notes');
		expect(fill(choose(notes, { count: 2 }), { count: 2 })).toBe('2 notes');
		expect(choose({ zero: 'none', other: 'some' }, { count: 0 })).toBe('some');
	});

	it('answers a key it has no message for with the key, rather than throwing', () => {
		expect(messageAt('shell.nowhere')).toBe('shell.nowhere');
		expect(messageAt('shell')).toBe('shell');
	});
});

describe('rich', () => {
	const bold = { b: (words: string) => <strong>{words}</strong> };

	it('renders the words a tag wraps with that tag’s function', () => {
		const { container } = render(
			<p>{markup('Delete <b>{name}</b> for good?', bold, { name: 'Ideas' })}</p>
		);
		expect(container.innerHTML).toBe('<p>Delete <strong>Ideas</strong> for good?</p>');
	});

	it('splits the tags out before filling, so a value that looks like a tag is text', () => {
		const { container } = render(<p>{markup('Delete {name}?', bold, { name: '<b>x</b>' })}</p>);
		expect(container.querySelector('strong')).toBeNull();
		expect(container.textContent).toBe('Delete <b>x</b>?');
	});

	it('leaves a tag it has no function for as written', () => {
		const { container } = render(<p>{markup('a <i>b</i> c', bold, {})}</p>);
		expect(container.textContent).toBe('a <i>b</i> c');
	});

	it('looks the message up by key, as t does', () => {
		const { container } = render(<p>{rich('shell.palette.noMatch', {}, { query: 'zip' })}</p>);
		expect(container.textContent).toBe('Nothing matches “zip”.');
	});
});

describe('the English catalog', () => {
	it('has something in it', () => {
		expect(ALL.length).toBeGreaterThan(0);
	});

	it.each(ALL)('%s is a message a translator can work with', (_key, message) => {
		if (isPlural(message)) {
			// Every key a plural category, so a namespace is never read as one.
			for (const key of Object.keys(message)) {
				expect(PLURAL_CATEGORIES).toContain(key);
			}
		}
		for (const text of textsOf(message)) {
			expect(text.trim()).not.toBe('');
			// A brace is only ever a placeholder's.
			expect(text.replace(/\{\w+\}/g, '')).not.toMatch(/[{}]/);
			// Every tag closed, and none inside another.
			const tags = text.replace(/<(\w+)>[^<]*<\/\1>/g, '');
			expect(tags).not.toMatch(/<\/?\w+>/);
		}
	});

	it('keeps no namespace that would be read as a plural', () => {
		const namespaces = (node: Catalog): Catalog[] =>
			Object.values(node).flatMap((value) =>
				typeof value === 'string' || isPlural(value) ? [] : [value, ...namespaces(value)]
			);
		for (const namespace of [en, ...namespaces(en)]) {
			for (const key of Object.keys(namespace)) {
				expect(PLURAL_CATEGORIES as readonly string[]).not.toContain(key);
			}
		}
	});
});

describe('the types', () => {
	it('ask for what a message needs and nothing else', () => {
		expectTypeOf<Args<'Cancel'>>().toEqualTypeOf<[]>();
		expectTypeOf<Args<'Nothing matches “{query}”.'>>().toEqualTypeOf<
			[params: Readonly<{ query: string | number }>]
		>();
		expectTypeOf<
			Args<Readonly<{ one: '1 note'; other: '{count} notes in {where}' }>>
		>().toExtend<[params: Readonly<{ count: number; where: string | number }>]>();

		// Never run: what it says is for the type checker, which has to refuse
		// every line of it.
		const unchecked = () => {
			// @ts-expect-error -- not a key
			t('common.nothing');
			// @ts-expect-error -- a namespace, not a message
			t('common');
			// @ts-expect-error -- the placeholder is not given
			t('shell.palette.noMatch');
			// @ts-expect-error -- a message with no placeholders takes no params
			t('common.cancel', { query: 'x' });
		};
		expect(unchecked).toBeTypeOf('function');
	});
});
