import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { api, type ApiClient } from '../api/client.js';
import { answer, useInstanceConfig } from '../api/instanceConfig.js';
import {
	type ConnectedSource,
	connectedSources,
	LABEL_LIMIT,
	renameSource,
	showConnection,
} from '../store/connection.js';
import { db as defaultDb, LOCAL_CONNECTION_ID, type NotesDatabase } from '../store/db.js';
import { CONNECTABLE, inOrder, PROVIDER_LABELS, tabName } from '../sync/account.js';
import { ConnectButton } from './ConnectButton.js';
import { useEscape } from './useEscape.js';

export interface SourceTabsProps {
	db?: NotesDatabase;
	client?: Pick<ApiClient, 'config' | 'startConnect'>;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
}

/**
 * Every set of notes on this device, across the top of the app.
 *
 * A device can hold several storage accounts at once, each its own silo — its
 * own notes, notebooks, queue and cursor (docs/PLAN.md §6) — and until now the
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
export const SourceTabs = ({
	db = defaultDb,
	client = api,
	returnTo,
	navigate,
}: SourceTabsProps) => {
	const sources = useLiveQuery(() => connectedSources(db), [db]);
	const config = useInstanceConfig(client);
	const [renaming, setRenaming] = useState<{ id: string; width: number } | null>(null);
	const [adding, setAdding] = useState(false);

	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];

	// The bar is the only place connections are made or chosen, so it is here
	// from the start — with nothing connected it is the `+` and nothing else,
	// which is the whole of what there is to offer. It goes away entirely only
	// when there is neither anything to show nor anything to offer: a
	// deployment with no providers, or a server that cannot be reached, where
	// an empty strip would be furniture standing in for a choice nobody has.
	if (sources === undefined || (sources.length === 0 && offerable.length === 0)) return null;

	const ordered = inOrder(sources);

	return (
		<div className="source-tabs">
			<nav aria-label="Sources">
				<ul>
					{ordered.map((source) => (
						<li key={source.connectionId}>
							{renaming?.id === source.connectionId ? (
								<RenameField
									name={tabName(source, ordered)}
									width={renaming.width}
									onDone={(chosen) => {
										setRenaming(null);
										if (chosen !== undefined)
											void renameSource(db, source.connectionId, chosen);
									}}
								/>
							) : (
								<SourceTab
									source={source}
									name={tabName(source, ordered)}
									onShow={(width) => {
										// A press on the tab already showing is the
										// way into renaming it, which is what makes
										// the name feel like part of the tab rather
										// than a setting filed somewhere else. The
										// pile has no row to write a name onto.
										if (!source.active) {
											void showConnection(db, source.connectionId);
											return;
										}
										if (source.connectionId !== LOCAL_CONNECTION_ID)
											setRenaming({ id: source.connectionId, width });
									}}
								/>
							)}
						</li>
					))}
				</ul>
			</nav>
			{offerable.length > 0 && (
				<div className="source-add">
					<button
						type="button"
						className="source-add-button"
						aria-label="Connect another account"
						aria-expanded={adding}
						onClick={() => {
							setAdding((open) => !open);
						}}
					>
						+
					</button>
					{adding && (
						<AddMenu
							onClose={() => {
								setAdding(false);
							}}
						>
							{offerable.map((provider) => (
								<ConnectButton
									key={provider}
									db={db}
									client={client}
									provider={provider}
									returnTo={returnTo}
									className="link"
									{...(navigate === undefined ? {} : { navigate })}
								>
									{PROVIDER_LABELS[provider]}
								</ConnectButton>
							))}
						</AddMenu>
					)}
				</div>
			)}
		</div>
	);
};

const SourceTab = ({
	source,
	name,
	onShow,
}: {
	source: ConnectedSource;
	name: string;
	/** With the width the tab is taking, so replacing it moves nothing. */
	onShow: (width: number) => void;
}) => (
	<button
		type="button"
		className={source.active ? 'source-tab source-tab-active' : 'source-tab'}
		// Said outright rather than left to be assembled from the two spans
		// below. The name from contents is not simply their text: it joins the
		// pieces by its own rules, so "A source" and " — disconnected" came out
		// as a name no caller could predict — and a test looking for the tab by
		// what it plainly says could not find it. Exactly the visible words, so
		// it still satisfies WCAG 2.5.3.
		aria-label={source.detached === undefined ? name : `${name} — disconnected`}
		// The tab the user is on, said once. `aria-current` is what a screen
		// reader announces; "showing" in the text as well would be read twice.
		{...(source.active ? { 'aria-current': 'true' as const } : {})}
		onClick={(event) => {
			onShow(event.currentTarget.offsetWidth);
		}}
	>
		<span className="source-tab-name">{name}</span>
		{source.detached !== undefined && (
			// Not an icon alone: a source that syncs nowhere is the one thing
			// about this bar a user must not have to infer from a colour.
			<span className="source-tab-detached"> — disconnected</span>
		)}
	</button>
);

/**
 * The tab, become its own name.
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
const RenameField = ({
	name,
	width,
	onDone,
}: {
	name: string;
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
			<input
				ref={field}
				className="source-tab-rename"
				aria-label={`Rename ${name}`}
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
 * What the `+` opens. Closes on Escape and on a press anywhere outside it,
 * which is the whole of what a menu this small owes anyone: the buttons inside
 * are ordinary buttons, and each one leaves the page for the provider.
 */
const AddMenu = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => {
	const menu = useRef<HTMLDivElement>(null);
	useEscape(menu, true, onClose);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && menu.current?.contains(target) === true) return;
			onClose();
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [onClose]);

	return (
		<div ref={menu} className="source-add-menu" role="group" aria-label="Storage providers">
			<p className="muted">Connect another account</p>
			{children}
		</div>
	);
};
