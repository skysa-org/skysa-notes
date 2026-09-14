import { createFakeProvider } from '../../src/providers/fake.js';
import { describeProviderContract } from './contract.js';

/**
 * The registry CLAUDE.md names: every provider adapter is registered here and
 * runs the same scenarios. Adapters that talk to a real account register a
 * second time behind `PROVIDER_LIVE_TESTS=1`, so CI stays offline.
 */

describeProviderContract('in-memory fake', () => ({ provider: createFakeProvider() }));

// The fake's own change feed is coalescing-free and paginates one entry at a
// time here, which is the weakest feed any real provider gives. An adapter that
// passes this also passes against a friendlier one.
describeProviderContract('in-memory fake, one entry per page', () => ({
	provider: createFakeProvider({ pageSize: 1 }),
}));

describeProviderContract('in-memory fake, provider reports whole subtrees', () => ({
	provider: createFakeProvider({ folderChanges: 'recursive' }),
}));
