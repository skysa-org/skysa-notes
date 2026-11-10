import { describeTokenSource } from './client/tokenSource.js';
import { dexieDevice } from './support/dexieDevice.js';

// The token source over this app's database, through `sync/dexiePorts.ts`:
// the suite the kit runs over the ports in memory (`tokens.test.ts`).
describeTokenSource('over the app’s database', dexieDevice);
