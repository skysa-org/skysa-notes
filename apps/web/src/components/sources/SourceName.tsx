import { type ReactNode, useEffect, useRef, useState } from 'react';

import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import { type ConnectedSource, LABEL_LIMIT, renameSource } from '../../store/connection.js';
import type { NotesDatabase } from '../../store/db.js';
import type { Renamings } from '../../store/renaming.js';
import { isLiveSource } from '../../store/rowStates.js';
import { ProviderIcon, type SourceKind } from '../ProviderIcon.js';

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
 * The tab, become its own name, with the provider's mark still in front of it.
 *
 * The field carries no box of its own — no padding, no background, no border,
 * no focus ring. The tab's own box is still there, around it, so entering a
 * rename changes nothing about the bar except that there is now a caret in the
 * name. A field with its own padding and border drew a second, smaller box
 * inside the tab and shifted the text of it.
 *
 * Nor does the tab change width. An `input` is as wide as its `size` attribute
 * and not as wide as its text, so swapping one in resized the tab and shoved
 * every tab after it sideways. The tab measures itself on the way in and the
 * wrapper is pinned to that. The name can then be longer than the room it has,
 * and scrolls inside it, which is what a tab of fixed width owes a long name
 * anyway.
 *
 * Nothing is measurable in jsdom, where `offsetWidth` is always 0, so a width
 * of nothing is left unset rather than pinning the field shut in the tests.
 *
 * Escape abandons it and Enter takes it, which is the pair every rename in
 * this app has. Blur takes it too: a click somewhere else is not "cancel", and
 * a field that threw the name away because the user looked at the note they
 * were naming it after would be its own bug report.
 *
 * The text starts selected. A rename is nearly always a replacement — "Dropbox
 * 2" into "Work" — and the alternative is every user clearing the field by
 * hand before they can start.
 */
export const RenameField = ({
	name,
	kind,
	width,
	onDone,
}: {
	name: string;
	kind: SourceKind;
	width: number;
	onDone: (chosen?: string) => void;
}) => {
	const [draft, setDraft] = useState(name);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);

	useEffect(() => {
		// Focus first, and not `select()` alone: `select()` focuses as a side
		// effect in a browser and does not everywhere, which leaves a field that
		// looks ready and swallows the first thing typed into it.
		field.current?.focus();
		field.current?.select();
	}, []);

	// Once. Escape blurs the field, and a blur handler that had not been told
	// the rename was already abandoned would put the name straight back.
	const finish = (chosen?: string) => {
		if (done.current) return;
		done.current = true;
		onDone(chosen);
	};

	return (
		<span
			className="source-tab source-tab-active source-tab-editing"
			{...(width > 0 ? { style: { width: `${String(width)}px` } } : {})}
		>
			<ProviderIcon kind={kind} />
			<input
				ref={field}
				className="source-tab-rename"
				aria-label={t('sources.rename', { name })}
				value={draft}
				maxLength={LABEL_LIMIT}
				onChange={(event) => {
					setDraft(event.target.value);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						finish(draft);
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						finish();
					}
				}}
				onBlur={() => {
					finish(draft);
				}}
			/>
		</span>
	);
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
