import { createMemoryStore } from './memoryStore.js';
import { describeSyncStoreContract } from './storeContract.js';

/**
 * The registry for `SyncStore` implementations, in the shape the provider
 * contract already uses. The Dexie store in `apps/web` registers here when it
 * lands, and the engine's promises are then checked against the thing the app
 * actually runs rather than only against the fixture.
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
