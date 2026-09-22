import type { LanguageSupport } from '@codemirror/language';
import { describe, expect, it, vi } from 'vitest';

import {
	CODE_LANGUAGES,
	type CodeLanguage,
	createLanguageSource,
	findCodeLanguage,
	markdownCodeLanguages,
} from '../src/editor/languages.js';

/**
 * The list of languages a code block can be written in.
 *
 * Two things here are worth a test and both are the kind that rot quietly. The
 * first is the list itself: an id or an alias that two languages both answer to
 * means a fence resolves to whichever was listed first, forever, and nothing on
 * screen would say so. The second is that every entry can actually be fetched —
 * a load is a dynamic import of a package name written by hand, and a typo in
 * one is a language that silently never colours anything.
 */

const json = async (): Promise<LanguageSupport> =>
	import('@codemirror/lang-json').then((module) => module.json());

describe('the language list', () => {
	it('gives every language one lower-case id of its own', () => {
		const ids = CODE_LANGUAGES.map((language) => language.id);

		expect(ids).toEqual(ids.map((id) => id.toLowerCase()));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('lets no two languages answer to the same word', () => {
		const words = CODE_LANGUAGES.flatMap((language) => [language.id, ...language.aliases]);

		expect(words).toEqual(words.map((word) => word.toLowerCase()));
		expect(new Set(words).size).toBe(words.length);
	});

	/** The picker is a list of thirty names; out of order it is a list to search. */
	it('is in alphabetical order by label', () => {
		const labels = CODE_LANGUAGES.map((language) => language.label.toLowerCase());

		expect(labels).toEqual([...labels].sort((a, b) => (a < b ? -1 : 1)));
	});

	it('can fetch every grammar it offers', async () => {
		for (const language of CODE_LANGUAGES) {
			const support = await language.load();
			expect(support.language.parser, language.id).toBeDefined();
		}
	}, 60_000);
});

describe('findCodeLanguage', () => {
	it('knows a language by its own name and by what people call it', () => {
		expect(findCodeLanguage('javascript')?.id).toBe('javascript');
		expect(findCodeLanguage('js')?.id).toBe('javascript');
		expect(findCodeLanguage('c++')?.id).toBe('cpp');
		expect(findCodeLanguage('yml')?.id).toBe('yaml');
	});

	it('does not care how the fence was capitalised', () => {
		expect(findCodeLanguage('JS')?.id).toBe('javascript');
		expect(findCodeLanguage('  Python ')?.id).toBe('python');
	});

	/** An info string can carry more than the language; only the first word is it. */
	it('reads the language and not the rest of the info string', () => {
		expect(findCodeLanguage('js title=example.js')?.id).toBe('javascript');
	});

	/**
	 * A word we do not know is not an error and must not be a near miss either:
	 * matched by prefix, `jsonnet` would come back as JSON and be coloured by
	 * the wrong grammar.
	 */
	it('answers nothing for a language it has never heard of', () => {
		expect(findCodeLanguage('jsonnet')).toBeUndefined();
		expect(findCodeLanguage('mermaid')).toBeUndefined();
		expect(findCodeLanguage('')).toBeUndefined();
		expect(findCodeLanguage(undefined)).toBeUndefined();
	});
});

describe('markdownCodeLanguages', () => {
	it('hands the raw editor the same list under the same names', () => {
		const descriptions = markdownCodeLanguages();

		expect(descriptions).toHaveLength(CODE_LANGUAGES.length);
		expect(descriptions.map((description) => description.name)).toEqual(
			CODE_LANGUAGES.map((language) => language.id)
		);
		expect(
			descriptions.find((description) => description.name === 'javascript')?.alias
		).toContain('js');
	});
});

describe('createLanguageSource', () => {
	const fake = (load: () => Promise<LanguageSupport>): readonly CodeLanguage[] => [
		{ id: 'fictional', label: 'Fictional', aliases: ['fic'], load },
	];

	it('has nothing to offer until the grammar has arrived', async () => {
		const languages = createLanguageSource(fake(json));

		expect(languages.get('fictional')).toBeUndefined();
		await languages.load('fictional');
		expect(languages.get('fictional')).toBeDefined();
	});

	it('fetches a language once however many blocks ask for it', async () => {
		const load = vi.fn(json);
		const languages = createLanguageSource(fake(load));

		await Promise.all([
			languages.load('fictional'),
			languages.load('fic'),
			languages.load('FICTIONAL'),
		]);
		await languages.load('fictional');

		expect(load).toHaveBeenCalledTimes(1);
	});

	/**
	 * Offline, before the service worker holds the chunk, the fetch fails. The
	 * block stays plain — which is what it already was — and the next note that
	 * wants the language asks again rather than being told forever that it is
	 * still on its way.
	 */
	it('asks again after a grammar fails to arrive', async () => {
		const load = vi
			.fn<() => Promise<LanguageSupport>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementation(json);
		const languages = createLanguageSource(fake(load));

		await languages.load('fictional');
		expect(languages.get('fictional')).toBeUndefined();

		await languages.load('fictional');
		expect(languages.get('fictional')).toBeDefined();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('says nothing about a language that is not in its list', async () => {
		const languages = createLanguageSource(fake(json));

		await languages.load('python');
		expect(languages.get('python')).toBeUndefined();
	});
});
