import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ERROR_CODES } from '@skysa/core';
import { describe, expect, it } from 'vitest';

/**
 * Every refusal goes out through `fail` (`src/http.ts`), which takes only a
 * code from core's list, so the app and the server read one list (#451). A
 * `c.json({ …, error: … })` written by hand would get past that, and so would
 * a literal typed as a plain string; this reads the source for both.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url).href);

const sources = (readdirSync(SRC, { recursive: true }) as string[])
	.filter((file) => file.endsWith('.ts'))
	.map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

/** Each code a route answers with, written where it is: `fail(c, '…'` or `error: '…'`. */
const named = sources.flatMap(({ text }) =>
	[...text.matchAll(/(?:\bfail\(c, |\berror: )'([a-z_]+)'/g)].map((match) => match[1])
);

describe('the error codes the API answers with (#451)', () => {
	it('answers every refusal through fail, and fail is the only answer with an error', () => {
		expect(
			sources
				.filter(({ text }) => /\.json\(\s*\{[^}]*\berror\b/.test(text))
				.map(({ file }) => file)
		).toEqual(['http.ts']);
	});

	it('names only codes in core’s list', () => {
		expect(named.length).toBeGreaterThan(0);
		expect(
			named.filter(
				(code) => !(API_ERROR_CODES as readonly (string | undefined)[]).includes(code)
			)
		).toEqual([]);
	});

	it('answers with every code in core’s list somewhere', () => {
		expect(API_ERROR_CODES.filter((code) => !named.includes(code))).toEqual([]);
	});
});
