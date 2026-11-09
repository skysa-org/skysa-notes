import { describe, expect, it } from 'vitest';

import { contentTypeOf } from '../../src/files/mediaTypes.js';

describe('contentTypeOf', () => {
	it.each([
		['a.png', 'image/png'],
		['a.JPG', 'image/jpeg'],
		// Told to the provider, for its own preview; never what this origin
		// opens it as (`safeOpenType`).
		['a.svg', 'image/svg+xml'],
		['a.heic', 'image/heic'],
		['a.pdf', 'application/pdf'],
		['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
		['a.qqq', undefined],
		['a.html', undefined],
		['README', undefined],
	])('%s → %s', (name, type) => {
		expect(contentTypeOf(name)).toBe(type);
	});
});
