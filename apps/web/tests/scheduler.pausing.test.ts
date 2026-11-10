import { memoryDevice } from './client/memoryDevice.js';
import { describePausing } from './client/pausing.js';

// Pausing and waiting over the ports in memory: no app's database, as the kit
// runs it (docs/decisions/0018-the-shared-kit.md). This app's own run, over its
// database and with its own scheduler, is `scheduler.pausing.dexie.test.ts`.
describePausing('over the ports in memory', memoryDevice);
