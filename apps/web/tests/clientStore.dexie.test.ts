import { describeClientStore } from '@skysa/client/testing';

import { dexieDevice } from './support/dexieDevice.js';

// The scheduler's port over this app's database (`clientStoreOf`, in
// `sync/dexiePorts.ts`): the contract the kit runs over the ports in memory
// (`clientStore.test.ts`).
describeClientStore('over the app’s database', dexieDevice);
