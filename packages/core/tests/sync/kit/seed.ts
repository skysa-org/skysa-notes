import type { RemoteEntry } from '../../../src/providers/types.js';

/**
 * What binds a row to the file it was pulled from, as a pull leaves it: a seed
 * spreads it (`{ ...boundTo(entry) }`) rather than write the two fields out.
 */
export const boundTo = (entry: RemoteEntry): { remoteId: string; remoteVersion: string } => ({
	remoteId: entry.remoteId,
	remoteVersion: entry.version,
});
