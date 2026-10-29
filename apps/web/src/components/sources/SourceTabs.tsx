import { type ReactNode, useState } from 'react';

import { api, type ApiClient } from '../../api/client.js';
import { t } from '../../i18n/t.js';
import { type ConnectedSource, LABEL_LIMIT, showConnection } from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { isLiveSource } from '../../store/rowStates.js';
import { CONNECT_FIRST_LABEL, tabName } from '../../sync/account.js';
import { syncScheduler, useNeedsReconnect } from '../../sync/runtime.js';
import type { SyncScheduler } from '../../sync/scheduler.js';
import { RowRename } from '../ui/RowRename.js';
import { AddSource } from './AddSource.js';
import { ProviderIcon, sourceKind } from './ProviderIcon.js';
import { ShownSourceName, sourceLabel, storeSourceName } from './SourceName.js';
import { useSourceChoices } from './useSourceChoices.js';

/**
 * The tab showing, and so the box its rename field wears: the same classes,
 * or the bar moves as the name becomes editable.
 */
const ACTIVE_TAB = 'source-tab source-tab-active';

export interface SourceTabsProps {
	client?: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
	/**
	 * The app's search field, which the route owns and the bar shows at its
	 * right-hand end: it asks every source, so it belongs beside the sources
	 * rather than inside any one pane of the source showing. With it given the
	 * bar is always shown, since there is then always something in it.
	 */
	search?: ReactNode;
	/** How many times the app's URL has asked for the code field (`useEnterCode`). */
	enterCode?: number;
	/** How the showing source's sync is going, which marks its tab when it needs connecting again. */
	sync?: Pick<SyncScheduler, 'status' | 'subscribe'>;
}

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
export const SourceTabs = ({
	client = api,
	returnTo,
	navigate,
	search,
	enterCode,
	sync = syncScheduler,
}: SourceTabsProps) => {
	const db = useDb();
	const choices = useSourceChoices(client);
	const { ordered, offerable, nothingToShow } = choices;
	// The scheduler syncs the showing source only, so it is the only one
	// known to need connecting again.
	const reconnect = useNeedsReconnect(sync);
	const [renaming, setRenaming] = useState<{ id: string; width: number } | null>(null);

	if (nothingToShow && search === undefined) return null;

	return (
		<div className="source-tabs">
			<nav aria-label={t('sources.title')}>
				<ul>
					{ordered.map((source) => (
						<li key={source.connectionId}>
							{renaming?.id === source.connectionId ? (
								<RowRename
									name={tabName(source, ordered)}
									selected
									className={`${ACTIVE_TAB} source-tab-editing`}
									width={renaming.width}
									mark={<ProviderIcon kind={sourceKind(source)} />}
									maxLength={LABEL_LIMIT}
									onDone={(chosen) => {
										setRenaming(null);
										storeSourceName(
											db,
											source.connectionId,
											tabName(source, ordered),
											chosen
										);
									}}
								/>
							) : (
								<SourceTab
									source={source}
									name={tabName(source, ordered)}
									reconnect={source.active && reconnect}
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
				<AddSource
					choices={choices}
					enterCode={enterCode}
					client={client}
					returnTo={returnTo}
					navigate={navigate}
					button={({ adding, toggle, first, label }) => (
						<button
							type="button"
							className={
								adding
									? 'source-add-button source-add-button-on'
									: 'source-add-button'
							}
							// Named by its words where it has them, which is when nothing is
							// connected; a bare `+` beside the tabs is named for what it does.
							{...(first ? {} : { 'aria-label': label })}
							aria-haspopup="true"
							aria-expanded={adding}
							onClick={toggle}
						>
							{first ? (
								<>
									<span aria-hidden="true">+</span>{' '}
									<span className="source-add-label">{CONNECT_FIRST_LABEL}</span>
								</>
							) : (
								'+'
							)}
						</button>
					)}
				/>
			)}
			{search !== undefined && <div className="source-search">{search}</div>}
		</div>
	);
};

const SourceTab = ({
	source,
	name,
	reconnect,
	onShow,
}: {
	source: ConnectedSource;
	name: string;
	/** It needs connecting again: a red dot on its mark, and said in its name and tooltip. */
	reconnect: boolean;
	/** With the width the tab is taking, so replacing it moves nothing. */
	onShow: (width: number) => void;
}) => {
	// The name once more on `data-name`, for the hidden bold copy that holds
	// the tab's width — see `.source-tab-name` in the stylesheet.
	const shownName = (words: string) => (
		<span className="source-tab-name" data-name={words}>
			<span>{words}</span>
		</span>
	);
	// Only a source that syncs is asked to connect again: one that syncs
	// nowhere is said as that, in its name, its tooltip and its mark alike.
	const reconnecting = reconnect && isLiveSource(source);
	return (
		<button
			type="button"
			className={source.active ? ACTIVE_TAB : 'source-tab'}
			// Said outright (`sourceLabel`): the name from contents joins the
			// spans below by its own rules, so "A source" and " — disconnected"
			// came out as a name no caller could predict.
			aria-label={sourceLabel(source, name, reconnecting)}
			{...(reconnecting ? { title: t('sources.reconnect', { source: name }) } : {})}
			// The tab the user is on, said once. `aria-current` is what a screen
			// reader announces; "showing" in the text as well would be read twice.
			{...(source.active ? { 'aria-current': 'true' as const } : {})}
			onClick={(event) => {
				onShow(event.currentTarget.offsetWidth);
			}}
		>
			<ProviderIcon kind={sourceKind(source)} alert={reconnecting} />
			<ShownSourceName source={source} name={name} shown={shownName} />
		</button>
	);
};
