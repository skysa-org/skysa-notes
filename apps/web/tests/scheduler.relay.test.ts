import { describeChangeRelay } from './client/changeRelay.js';
import { memoryDevice } from './client/memoryDevice.js';

// The change relay over the ports in memory: no app's database, as the kit runs
// it (docs/decisions/0018-the-shared-kit.md). This app's own run, over its
// database and with its own scheduler, is `scheduler.relay.dexie.test.ts`.
describeChangeRelay('over the ports in memory', memoryDevice);
