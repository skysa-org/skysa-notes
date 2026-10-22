import { useSyncExternalStore } from 'react';

import { api } from '../api/client.js';
import { db } from '../store/db.js';
import { createProviderFactory } from './providers.js';
import { createRelayFactory } from './relay.js';
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
	// Asks `/config` first, so an instance without a relay is never asked for
	// a ticket (`sync/relay.ts`).
	relay: createRelayFactory({ db, client: api }),
});

/** What the scheduler says now, re-rendering whenever that changes. */
export const useSyncStatus = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): SchedulerStatus => useSyncExternalStore(scheduler.subscribe, scheduler.status);

/**
 * A problem that connecting the account again is the answer to: said in the
 * storage panel as what to do, with the button, and marked on the showing
 * source's mark, on its tab and on a compact window's source dropdown.
 */
export const needsReconnect = (status: SchedulerStatus): boolean =>
	status.phase === 'attention' &&
	(status.refusal === 'credential_required' ||
		status.refusal === 'credential_revoked' ||
		status.refusal === 'reauthorize_required' ||
		(status.refusal === undefined && status.error === 'authorization required'));

/** Whether the showing source needs connecting again, re-rendering as that changes. */
export const useNeedsReconnect = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): boolean => useSyncExternalStore(scheduler.subscribe, () => needsReconnect(scheduler.status()));
