import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { API_ERROR_CODES } from '@skysa/core';
import { describe, expect, it } from 'vitest';

/**
 * Every refusal goes out through `fail` (`src/http.ts`), which takes only a
 * code from core's list, so the app and the server read one list (#451). A
 * `c.json({ error: … })` written by hand would get past that, and so would a
 * literal typed as a plain string; this reads the source for both.
 */
const SRC = new URL('../src/', import.meta.url).pathname;

const sources = (readdirSync(SRC, { recursive: true }) as string[])
	.filter((file) => file.endsWith('.ts'))
	.map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

describe('the error codes the API answers with (#451)', () => {
	it('answers every refusal through fail, and fail is the only answer with an error', () => {
		expect(
			sources
				.filter(({ text }) => /c\.json\(\s*\{\s*error\b/.test(text))
				.map(({ file }) => file)
		).toEqual(['http.ts']);
	});

	it('names only codes in core’s list', () => {
		const named = sources.flatMap(({ text }) =>
			[...text.matchAll(/\berror: '([a-z_]+)'/g)].map((match) => match[1])
		);
		expect(named.length).toBeGreaterThan(0);
		expect(
			named.filter(
				(code) => !(API_ERROR_CODES as readonly (string | undefined)[]).includes(code)
			)
		).toEqual([]);
	});

	it('names every code in core’s list somewhere', () => {
		const text = sources.map((source) => source.text).join('\n');
		expect(API_ERROR_CODES.filter((code) => !text.includes(`'${code}'`))).toEqual([]);
	});
});
