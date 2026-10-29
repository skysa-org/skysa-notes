import type { ProviderKind } from '@skysa/core';

import { t } from '../i18n/t.js';
import type { ConnectedSource } from '../store/connection.js';
import { LOCAL_CONNECTION_ID } from '../store/db.js';

/**
 * What the app calls a source, from what the device holds of it: the
 * provider's name, numbered where there are two, or the name the user gave
 * it. Apart from the rest of `account.ts`, which reaches the sync, so a page
 * that only names sources, the fill window, loads none of it.
 */

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
	dropbox: 'Dropbox',
	onedrive: 'OneDrive',
	gdrive: 'Google Drive',
	webdav: 'WebDAV',
};

/** The device's own pile, which is not a connection and so has no provider. */
const PILE_LABEL: string = t('account.pile');

/**
 * A source whose row no longer says which provider it was: one brought back by
 * a save landing after the connection went (`ensureDetached`). It is not the
 * pile — it holds an account's work and can be reconnected — and calling it
 * "This device" would put two tabs of that name side by side, which is exactly
 * the state this bar exists to prevent.
 */
export const UNKNOWN_LABEL: string = t('account.unknownSource');

/**
 * A source in as few words as will do: "Dropbox", or "Dropbox 2" where there
 * is more than one of them.
 *
 * The user's own name wins outright, and is the reason this can afford to be
 * so short — anyone with two Dropbox accounts who cannot tell "Dropbox" from
 * "Dropbox 2" renames one, which is a click on the tab. Where they have not
 * said, the name is the provider's, numbered only against *other sources of
 * the same provider*, in the order they were connected. The first of a
 * provider carries no number: "Dropbox" and "Dropbox 2", never "Dropbox 1".
 *
 * Derived rather than written down at connect time, which is a real trade and
 * goes this way for two reasons. Every source already on a device gets a name
 * without a backfill; and "if there are conflicts" stays true as the set
 * changes, so letting go of the first Dropbox leaves the other one called
 * "Dropbox" rather than leaving a "Dropbox 2" with no 1. The cost is that a
 * name the user never chose can move under them when another source goes,
 * which is exactly what renaming is for, and a renamed source is pinned.
 *
 * Numbering counts every source of the provider, renamed ones included. It has
 * to: numbering only the unnamed ones would renumber the rest each time
 * somebody typed a name, which is the churn this is trying to avoid, and the
 * point of a number is to say which of several this is.
 */
export const tabName = (
	source: Pick<ConnectedSource, 'connectionId' | 'provider' | 'label'>,
	all: readonly Pick<ConnectedSource, 'connectionId' | 'provider' | 'boundAt'>[]
): string => {
	if (source.label !== undefined && source.label !== '') return source.label;
	if (source.connectionId === LOCAL_CONNECTION_ID) return PILE_LABEL;
	if (source.provider === undefined) return UNKNOWN_LABEL;
	const sameProvider = inOrder(all).filter((other) => other.provider === source.provider);
	const place = sameProvider.findIndex((other) => other.connectionId === source.connectionId);
	const provider = PROVIDER_LABELS[source.provider];
	return place <= 0 ? provider : t('account.numbered', { provider, number: String(place + 1) });
};

/**
 * Sources in the order the user made them, which is the order to show them in
 * and the order to number them by.
 *
 * `syncState.toArray()` answers in primary-key order — by connection id, which
 * is the server's and means nothing to anybody — so a bar built straight off it
 * would put the account connected this morning in front of the one connected
 * last year, and reshuffle when an id happened to sort differently. `boundAt`
 * is what the rows actually record about when they arrived; the pile has none
 * and sorts last, where it belongs, since it is what was written before any of
 * them.
 */
export const inOrder = <T extends Pick<ConnectedSource, 'connectionId' | 'boundAt'>>(
	sources: readonly T[]
): T[] =>
	[...sources].sort((left, right) => {
		const when = (source: T) => source.boundAt ?? Number.MAX_SAFE_INTEGER;
		// By id where two rows carry the same instant, so the order is total and
		// a tab never swaps places with its neighbour between renders.
		return when(left) - when(right) || left.connectionId.localeCompare(right.connectionId);
	});
