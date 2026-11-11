import { describePushTiming } from '@skysa/client/testing';

import { dexieDevice } from './support/dexieDevice.js';

// When a push goes, over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.timing.test.ts`).
describePushTiming('over the app’s database', dexieDevice);
