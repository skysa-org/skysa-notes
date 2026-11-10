import { describe, expect, it } from 'vitest';

import { outOfAttempts } from '../../src/sync/attempts.js';

describe('an op out of attempts', () => {
	it('is one tried as many times as allowed, or more', () => {
		expect(outOfAttempts({ op: 'write', attempts: 3 }, 3)).toBe(true);
		expect(outOfAttempts({ op: 'write', attempts: 4 }, 3)).toBe(true);
		expect(outOfAttempts({ op: 'write', attempts: 2 }, 3)).toBe(false);
	});

	it('is never an rmdir, which the engine gives up on rather than stops at', () => {
		expect(outOfAttempts({ op: 'rmdir', attempts: 3 }, 3)).toBe(false);
		expect(outOfAttempts({ op: 'mkdir', attempts: 3 }, 3)).toBe(true);
	});

	it('is an upload, which the engine steps over but keeps and is blocked by', () => {
		expect(outOfAttempts({ op: 'upload', attempts: 3 }, 3)).toBe(true);
	});
});
