import { NOTE_FORMAT, NOTES_FOLDER, syncsHidden } from '@skysa/core';
import { useSyncExternalStore } from 'react';

import { api } from '../api/client.js';
import { t } from '../i18n/t.js';
import { db } from '../store/db.js';
import { SYNC_LOCK } from './lock.js';
import { createNotesSync, type NotesSync } from './notesSync.js';
import { createProviderFactory } from './providers.js';
import { createRelayFactory } from './relay.js';
import type { SchedulerStatus, SyncScheduler } from './scheduler.js';
import { needsReconnect } from './status.js';

/**
 * The app's one sync scheduler, over the app's one database, with what the app
 * syncs beside the notes attached to it (`sync/notesSync.ts`). Started by
 * `main.tsx` before the first render, not by a component, so a remount — or
 * React running an effect twice in development — never stops and starts it.
 */

/** Written into the marker file on first connect. */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';

export const syncScheduler: NotesSync = createNotesSync({
	db,
	client: api,
	createProvider: createProviderFactory({
		folder: NOTES_FOLDER,
		document: NOTE_FORMAT,
		appVersion: APP_VERSION,
		timedOut: () => t('account.status.timedOut'),
	}),
	lockName: SYNC_LOCK,
	document: NOTE_FORMAT,
	syncsHidden,
	// Asks `/config` first, so an instance without a relay is never asked for
	// a ticket (`sync/relay.ts`).
	relay: createRelayFactory({ credentials: db, client: api }),
});

/** What the scheduler says now, re-rendering whenever that changes. */
export const useSyncStatus = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): SchedulerStatus => useSyncExternalStore(scheduler.subscribe, scheduler.status);

/** Whether the showing source needs connecting again, re-rendering as that changes. */
export const useNeedsReconnect = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): boolean => useSyncExternalStore(scheduler.subscribe, () => needsReconnect(scheduler.status()));
