import { describe, expect, it } from 'vitest';

import { SYNC_LOCK } from '../src/sync/lock.js';

describe('SYNC_LOCK', () => {
	it('is the name every build since 1.0 has taken a connection’s sync by', () => {
		// A tab still running an older build takes the lock by this name, so a
		// new one here would let two tabs sync one connection at once.
		expect(SYNC_LOCK('c1')).toBe('skysa-notes:sync:c1');
	});
});
