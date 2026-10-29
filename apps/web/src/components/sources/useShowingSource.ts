import { api, type ApiClient } from '../../api/client.js';
import { t } from '../../i18n/t.js';
import { type Renaming, shownSourceName } from '../../store/renaming.js';
import { tabName } from '../../sync/account.js';
import { syncScheduler, useNeedsReconnect } from '../../sync/runtime.js';
import type { SyncScheduler } from '../../sync/scheduler.js';
import { type SourceKind, sourceKind } from './ProviderIcon.js';
import { useSourceChoices } from './useSourceChoices.js';

/**
 * What the compact bar's source dropdown is about: the source showing, or
 * plain "Storage" before there is one — the dropdown is there regardless,
 * because the storage panel is in it. Its name, for the trigger's tooltip and
 * for a screen reader, which storage it is, for the mark the trigger shows
 * in place of the name, and whether it needs connecting again, for the red
 * dot on the mark.
 */
export const useShowingSource = (
	renaming?: Renaming,
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'> = api,
	sync: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): { name: string; kind: SourceKind; reconnect: boolean } => {
	const { ordered } = useSourceChoices(client);
	const reconnect = useNeedsReconnect(sync);
	const showing = ordered.find((source) => source.active);
	return showing === undefined
		? { name: t('sources.storage'), kind: undefined, reconnect: false }
		: {
				name: shownSourceName(showing.connectionId, tabName(showing, ordered), renaming),
				kind: sourceKind(showing),
				reconnect,
			};
};
