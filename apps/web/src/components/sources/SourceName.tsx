import type { ReactNode } from 'react';

import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import { type ConnectedSource, renameSource } from '../../store/connection.js';
import type { NotesDatabase } from '../../store/db.js';
import type { Renamings } from '../../store/renaming.js';
import { isLiveSource } from '../../store/rowStates.js';

/**
 * A name typed into a source's rename field, stored: the tab's own field in a
 * wide window, or the storage panel's in a narrow one, so the two answer alike.
 *
 * `was` is the name the source was shown under. The same name given back
 * stores nothing: it may be the derived one ("Dropbox", "Dropbox 2"), and
 * stored it would pin the source to it, no longer following the account.
 * `renamings`, where the caller has it, shows what was given until the store
 * has it, and lets go of it if the store turns it down, which leaves the name
 * the source had.
 */
export const storeSourceName = (
	db: NotesDatabase,
	connectionId: string,
	was: string,
	chosen: string | undefined,
	renamings?: Renamings
): void => {
	const trimmed = chosen?.trim();
	// Escape, or nothing changed: nothing to store, and nothing to wait for.
	// Nothing typed is a name given — the source's own, back again — but one
	// the dropdown already says, since an empty name shows what is stored.
	if (trimmed === undefined || trimmed === was || trimmed === '') {
		renamings?.clear('source', connectionId);
	} else {
		renamings?.give('source', connectionId, was);
	}
	if (chosen === undefined || trimmed === was) return;
	void renameSource(db, connectionId, chosen).catch(() => {
		renamings?.clear('source', connectionId);
	});
};

/**
 * A source's name as a screen reader is told it: one that syncs nowhere says
 * so, and a live one that needs connecting again (`reconnect`, where the place
 * shows that) says that. Said outright, in the bar and the source dropdown
 * alike, rather than left to be assembled from the spans `ShownSourceName`
 * draws, which the name from contents joins by its own rules. The visible
 * words are in it, so it still satisfies WCAG 2.5.3.
 */
export const sourceLabel = (source: ConnectedSource, name: string, reconnect = false): string =>
	!isLiveSource(source)
		? t('sources.disconnected.label', { source: name })
		: reconnect
			? t('sources.reconnect', { source: name })
			: name;

/**
 * A source's name on screen, and a disconnected one's with the words that say
 * so — not an icon alone: a source that syncs nowhere is the one thing about
 * the bar a user must not have to infer from a colour. `shown` draws the name
 * itself, where a place has its own way to (the tab holds its width with it).
 */
export const ShownSourceName = ({
	source,
	name,
	shown = (words) => words,
}: {
	source: ConnectedSource;
	name: string;
	shown?: (words: string) => ReactNode;
}) =>
	isLiveSource(source)
		? shown(name)
		: rich(
				'sources.disconnected.shown',
				{
					name: shown,
					state: (words) => <span className="source-tab-detached">{words}</span>,
				},
				{ source: name }
			);
