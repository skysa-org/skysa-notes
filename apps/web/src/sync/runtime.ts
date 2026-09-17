import { useSyncExternalStore } from 'react';

import { api } from '../api/client.js';
import { db } from '../store/db.js';
import { createProviderFactory } from './providers.js';
import { createSyncScheduler, type SchedulerStatus, type SyncScheduler } from './scheduler.js';

/**
 * The app's one sync scheduler, over the app's one database. Started by
 * `main.tsx` before the first render, not by a component, so a remount — or
 * React running an effect twice in development — never stops and starts it.
 */

/** Written into the marker file on first connect. */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';

export const syncScheduler: SyncScheduler = createSyncScheduler({
	db,
	client: api,
	createProvider: createProviderFactory({ appVersion: APP_VERSION }),
});

/** What the scheduler says now, re-rendering whenever that changes. */
export const useSyncStatus = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): SchedulerStatus => useSyncExternalStore(scheduler.subscribe, scheduler.status);
