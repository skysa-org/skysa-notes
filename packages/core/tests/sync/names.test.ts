import { describe, expect, it } from 'vitest';

import { type Claim, findFreeName } from '../../src/sync/names.js';

/** `x.md`, then `x-2.md`, `x-3.md`…: the next number free of `taken`. */
const numbered = (taken: readonly string[]): string => {
	const at = (n: number): string => (n === 1 ? 'x.md' : `x-${n}.md`);
	const free = (n: number): string => (taken.includes(at(n)) ? free(n + 1) : at(n));
	return `dir/${free(1)}`;
};

const takenUnless =
	(free: readonly string[], tried: string[]) =>
	(path: string): Promise<Claim<string>> => {
		tried.push(path);
		return Promise.resolve(free.includes(path) ? { free: path } : { taken: path });
	};

describe('findFreeName', () => {
	it('answers the first name claimed, and tries no further', async () => {
		const tried: string[] = [];
		const found = await findFreeName({
			candidate: numbered,
			claim: takenUnless(['dir/x-3.md', 'dir/x-4.md'], tried),
			attempts: 10,
			exhausted: () => new Error('none'),
		});
		expect(found).toBe('dir/x-3.md');
		// Each try made with the basenames already taken.
		expect(tried).toEqual(['dir/x.md', 'dir/x-2.md', 'dir/x-3.md']);
	});

	it('answers what the claim gave, not the name', async () => {
		const found = await findFreeName({
			candidate: numbered,
			claim: (path) => Promise.resolve({ free: { at: path } }),
			attempts: 1,
			exhausted: () => new Error('none'),
		});
		expect(found).toEqual({ at: 'dir/x.md' });
	});

	it('starts from the names it is told are taken', async () => {
		const tried: string[] = [];
		await findFreeName({
			candidate: numbered,
			claim: takenUnless(['dir/x-3.md'], tried),
			attempts: 10,
			exhausted: () => new Error('none'),
			taken: ['x.md', 'x-2.md'],
		});
		expect(tried).toEqual(['dir/x-3.md']);
	});

	it('tries exactly as many names as it may, then throws what exhausted makes of the last', async () => {
		const tried: string[] = [];
		const search = findFreeName({
			candidate: numbered,
			claim: takenUnless([], tried),
			attempts: 4,
			exhausted: (why) => new Error(`out at ${String(why)}`),
		});
		await expect(search).rejects.toThrow('out at dir/x-4.md');
		expect(tried).toHaveLength(4);
	});

	it('can throw the refusal itself', async () => {
		const refusal = new Error('taken there');
		const search = findFreeName({
			candidate: numbered,
			claim: () => Promise.resolve({ taken: refusal }),
			attempts: 2,
			exhausted: (why) => why,
		});
		await expect(search).rejects.toBe(refusal);
	});

	it('stops when the same name keeps coming back', async () => {
		// The drift the bound is for: a `candidate` that no longer recognises
		// its own names hands back the same one every time. The search stops.
		const tried: string[] = [];
		const search = findFreeName({
			candidate: () => 'dir/x.md',
			claim: takenUnless([], tried),
			attempts: 3,
			exhausted: () => new Error('none'),
		});
		await expect(search).rejects.toThrow('none');
		expect(tried).toHaveLength(3);
	});
});
