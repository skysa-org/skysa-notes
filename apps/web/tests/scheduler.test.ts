import { memoryDevice } from './client/memoryDevice.js';
import { describeScheduling } from './client/scheduling.js';

// The scheduler over the ports in memory: no app's database, as the kit runs
// it (docs/decisions/0018-the-shared-kit.md). This app's own run, over its
// database and with its own scheduler, is `scheduler.dexie.test.ts`.
describeScheduling('over the ports in memory', memoryDevice);
