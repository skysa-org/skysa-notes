import { describe, expect, it } from 'vitest';

import { asObject, isJsonObject, parseJson } from '../src/json.js';

describe('parseJson', () => {
	it.each([
		['{"a":1}', { a: 1 }],
		['[1,2]', [1, 2]],
		['null', null],
		['"text"', 'text'],
		['0', 0],
	])('reads %s', (text, value) => {
		expect(parseJson(text)).toEqual(value);
	});

	it.each(['', '{', 'undefined', '{"a":1}x', '﻿{}'])('answers undefined for %j', (text) => {
		expect(parseJson(text)).toBeUndefined();
	});
});

describe('a JSON object', () => {
	it.each([
		[{ a: 1 }, true],
		[{}, true],
		[null, false],
		[[], false],
		['text', false],
		[3, false],
		[undefined, false],
	])('%j is one: %s', (value, object) => {
		expect(isJsonObject(value)).toBe(object);
		expect(asObject(value)).toEqual(object ? value : {});
	});
});
