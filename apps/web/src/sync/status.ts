import type { SchedulerStatus } from './scheduler.js';

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
