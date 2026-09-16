import { createMemoryStore } from './memoryStore.js';
import { describeSyncStoreContract } from './storeContract.js';

/**
 * The registry for `SyncStore` implementations that live in `packages/core`, in
 * the shape the provider contract already uses. The Dexie store registers in
 * `apps/web/tests/syncStore.test.ts` instead — `core` cannot import `apps/*` —
 * so the engine's promises are checked against the thing the app actually runs
 * rather than only against the fixture.
 */

describeSyncStoreContract('in-memory', () => {
	const store = createMemoryStore();
	return {
		store,
		seed: store.put,
		seedFolder: store.putFolder,
		seedOp: (op) => store.queue(op).seq,
	};
});
