import { memoryDevice } from './client/memoryDevice.js';
import { describeTokenSource } from './client/tokenSource.js';

// The token source over the ports in memory: no app's database, as the kit
// runs it (docs/decisions/0018-the-shared-kit.md). This app's own run, over
// its database, is `tokens.dexie.test.ts`.
describeTokenSource('over the ports in memory', memoryDevice);
