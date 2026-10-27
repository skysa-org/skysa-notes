import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatIssues, parseJson } from '../src/json.js';

const shape = z.object({ a: z.number() });

describe('parseJson', () => {
	it('reads JSON of the shape asked for', () => {
		expect(parseJson('{"a":1}', shape)).toEqual({ a: 1 });
	});

	it('is nothing for text that is not JSON, or JSON of another shape', () => {
		expect(parseJson('{a:1}', shape)).toBeUndefined();
		expect(parseJson('', shape)).toBeUndefined();
		expect(parseJson('{"a":"1"}', shape)).toBeUndefined();
		expect(parseJson('null', shape)).toBeUndefined();
	});
});

describe('formatIssues', () => {
	it('names each field, or the root, with what was wrong and never the value', () => {
		const result = z
			.object({ outer: z.object({ inner: z.string() }), n: z.number() })
			.safeParse({ outer: { inner: 5 }, n: 'hush' });
		const lines = formatIssues(result.error?.issues ?? []);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^outer\.inner: /);
		expect(lines[1]).toMatch(/^n: /);
		expect(lines.join('\n')).not.toContain('hush');
		expect(formatIssues([{ path: [], message: 'm' }])).toEqual(['(root): m']);
		expect(formatIssues([{ path: [Symbol('s'), 0], message: 'm' }])).toEqual([
			'Symbol(s).0: m',
		]);
	});
});
