import { describeFailures } from './client/failures.js';
import { memoryDevice } from './client/memoryDevice.js';

// A sync failing, over the ports in memory: no app's database, as the kit runs
// it (docs/decisions/0018-the-shared-kit.md). This app's own run, over its
// database and with its own scheduler, is `scheduler.failures.dexie.test.ts`.
describeFailures('over the ports in memory', memoryDevice);
