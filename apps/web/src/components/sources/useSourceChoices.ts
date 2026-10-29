import { useLiveQuery } from 'dexie-react-hooks';

import type { ApiClient } from '../../api/client.js';
import { answer, useInstanceConfig } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import { connectedSources } from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { isLiveSource } from '../../store/rowStates.js';
import { anyConnected, CONNECT_FIRST_LABEL, CONNECTABLE, inOrder } from '../../sync/account.js';

/**
 * What the bar offers: the sources in the order they are shown, and the
 * providers another account can be connected from. Shared by the tabs and the
 * compact window's dropdown, which are the same choice drawn two ways.
 */
export const useSourceChoices = (
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>
) => {
	const db = useDb();
	const sources = useLiveQuery(() => connectedSources(db), [db]);
	const config = useInstanceConfig(client);

	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];

	const ordered = inOrder(sources ?? []);

	return {
		ordered,
		offerable,
		gate: settings?.connectGate,
		// This device has an account syncing here now, which the operator's
		// policy let in at least once: it is shown the buttons, with the gate
		// beside them rather than in front of them. A detached source does not
		// count — it syncs nowhere.
		live: ordered.some(
			(source) => source.connectionId !== LOCAL_CONNECTION_ID && isLiveSource(source)
		),
		// Nothing connected yet, as a fact rather than read back from the words
		// below, which two languages could make the same.
		first: !anyConnected(ordered),
		// "Connect another account" once there is one; before that, what
		// connecting is (`CONNECT_FIRST_LABEL`).
		connectLabel: anyConnected(ordered) ? t('sources.connectAnother') : CONNECT_FIRST_LABEL,
		// The bar is the only place connections are made or chosen, so it is
		// here from the start — with nothing connected it is the `+` and nothing
		// else, which is the whole of what there is to offer. It goes away
		// entirely only when there is neither anything to show nor anything to
		// offer: a deployment with no providers, or a server that cannot be
		// reached, where an empty strip would be furniture standing in for a
		// choice nobody has.
		nothingToShow: sources === undefined || (sources.length === 0 && offerable.length === 0),
	};
};
