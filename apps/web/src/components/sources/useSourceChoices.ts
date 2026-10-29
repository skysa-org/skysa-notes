import { useLiveQuery } from 'dexie-react-hooks';

import type { ApiClient } from '../../api/client.js';
import { answer, useInstanceConfig } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import { connectedSources } from '../../store/connection.js';
import { LOCAL_CONNECTION_ID, type NotesDatabase } from '../../store/db.js';
import { isLiveSource } from '../../store/rowStates.js';
import { anyConnected, CONNECT_FIRST_LABEL, CONNECTABLE, inOrder } from '../../sync/account.js';

/**
 * Every set of notes on this device, across the top of the app.
 *
 * A device can hold several storage accounts at once, each its own silo — its
 * own notes, notebooks, queue and cursor (docs/ARCHITECTURE.md §6) — and until now the
 * only way between them was a list inside the storage panel at the foot of the
 * sidebar. That is a long way to go for something a user with two accounts
 * does all day, and it gave no standing answer to "which of these am I
 * looking at". Tabs are that answer.
 *
 * Everything `connectedSources` knows about is here, not only the live ones: a
 * detached source holds work its remote was never sent and is editable, so a
 * bar that left it out would be a bar that hides notes. The device's own pile
 * is here too, when it holds anything.
 *
 * `nav` and `aria-current`, not `role="tablist"`. The ARIA tab pattern owes
 * arrow-key navigation, a roving `tabindex` and an `aria-controls` pointing at
 * a panel — and the "panel" here is the entire application, which is not one
 * element and is not re-rendered as one. A row of links to places, with the
 * one you are at marked, is what this actually is, and it costs a screen
 * reader user nothing.
 */
/**
 * What the bar offers: the sources in the order they are shown, and the
 * providers another account can be connected from. Shared by the tabs and the
 * compact window's dropdown, which are the same choice drawn two ways.
 */
export const useSourceChoices = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>
) => {
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
