import { type ApiClient } from '../../api/client.js';
import { type SyncScheduler } from '../../sync/scheduler.js';

/** The parts of the API client and the scheduler the storage panel uses. */

export type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

export type Sync = Pick<
	SyncScheduler,
	'status' | 'subscribe' | 'syncNow' | 'resync' | 'halt' | 'pause' | 'clipboard' | 'keyFile'
>;
