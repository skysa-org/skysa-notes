import { describe, expect, it } from 'vitest';

import { dropboxOAuth } from '../src/oauth/dropbox.js';
import type { FetchLike } from '../src/oauth/types.js';

const answering =
	(body: string): FetchLike =>
	() =>
		Promise.resolve(new Response(body, { status: 200 }));

const nameFrom = (body: string): Promise<string> =>
	dropboxOAuth.accountName(answering(body), { accessToken: 'a', expiresAt: 0 });

describe("Dropbox's account name", () => {
	it('is the email, else the display name', async () => {
		expect(await nameFrom('{"email":"a@b.c","name":{"display_name":"A"}}')).toBe('a@b.c');
		expect(await nameFrom('{"name":{"display_name":"A"}}')).toBe('A');
	});

	// Checked, not cast (#450): what is not a name is passed over, never stored.
	it('passes over a field that is not a name, and falls back rather than failing', async () => {
		expect(await nameFrom('{"email":"","name":{"display_name":"A"}}')).toBe('A');
		expect(await nameFrom('{"email":5,"name":"A"}')).toBe('Dropbox');
		expect(await nameFrom('null')).toBe('Dropbox');
		expect(await nameFrom('not json')).toBe('Dropbox');
	});
});
