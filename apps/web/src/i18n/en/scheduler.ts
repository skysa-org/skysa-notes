/**
 * What the sync scheduler says itself of why a sync stopped, where nothing
 * else did. The storage panel and the import dialog show it beside their own
 * words; what a provider or the server said is shown as they said it.
 */
export const scheduler = {
	/** A sync that failed without a reason of its own. Shown in brackets after the panel's words. */
	failed: 'Sync failed',
	unsupported: 'This app cannot sync with this storage provider yet.',
} as const;
