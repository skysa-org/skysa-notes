import { createSecretsLock, type SecretsLock } from './lock.js';

/** This tab's lock (`secrets/lock.ts`), over its page. */
export const tabLock: SecretsLock = createSecretsLock({ target: document });
