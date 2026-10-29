import type { ApiClient, InstanceConfig } from '../../api/client.js';
import type { Asked } from '../../api/instanceConfig.js';
import type { SyncScheduler } from '../../sync/scheduler.js';
import type { AccountSlot } from '../sources/SourcePanel.js';

/**
 * The parts of the API client and the scheduler the storage panel uses, and
 * the props its local and detached panels share.
 */

export type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

export type Sync = Pick<
	SyncScheduler,
	'status' | 'subscribe' | 'syncNow' | 'resync' | 'halt' | 'pause' | 'clipboard' | 'keyFile'
>;

export interface LocalProps {
	client: Client;
	config: Asked<InstanceConfig>;
	returnTo: string;
	navigate?: (url: string) => void;
	slot?: AccountSlot;
}
