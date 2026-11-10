import { describeConnection } from './client/connection.js';
import { memoryDevice } from './client/memoryDevice.js';

// The scheduler following the connection over the ports in memory: no app's
// database, as the kit runs it (docs/decisions/0018-the-shared-kit.md). This
// app's own run, over its database and with its own scheduler, is
// `scheduler.connection.dexie.test.ts`.
describeConnection('over the ports in memory', memoryDevice);
