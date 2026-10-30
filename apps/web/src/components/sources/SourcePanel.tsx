import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { api, type ApiClient } from '../../api/client.js';
import { t } from '../../i18n/t.js';
import { type ConnectedSource, LABEL_LIMIT, showConnection } from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { holdsAnything } from '../../store/exportNotes.js';
import { isLiveSource } from '../../store/rowStates.js';
import { CONNECTABLE, tabName } from '../../sync/account.js';
import { secretsLabel } from '../secrets/secretsLabel.js';
import { useRenamings } from '../shell/context.js';
import type { OptionsMenuItem } from '../ui/OptionsMenu.js';
import { RowOptions } from '../ui/RowOptions.js';
import { RowRename } from '../ui/RowRename.js';
import { AddSource } from './AddSource.js';
import { ProviderIcon, sourceKind } from './ProviderIcon.js';
import { ShownSourceName, sourceLabel, storeSourceName } from './SourceName.js';
import { useSourceChoices } from './useSourceChoices.js';

/**
 * A choice made from the `⋯` of a source that is not the one showing. The
 * storage panel acts only on the source showing — the scheduler syncs only
 * that one, and its questions are asked in its panel — so the choice shows the
 * source first, and its panel carries this out once it is there
 * (`account/useAsked.ts`). Sync now needs no asking: showing a source syncs
 * it.
 */
export interface SourceAsk {
	connectionId: string;
	action: 'rescan' | 'download' | 'secrets' | 'disconnect';
}

/** What the source panel hands the storage panel under it. */
export interface AccountSlot {
	/** Rename the showing source, where it can be: its row becomes the field. */
	onRename?: () => void;
	/**
	 * Where the showing source's `⋯` goes: the end of its row, as every other
	 * source's is (`ActionsMenu` in `account/PanelMenus.tsx`). Null until the row is drawn.
	 */
	menuIn: HTMLElement | null;
	/** What the showing source's row calls it, for its `⋯`. */
	name: string;
	asked: SourceAsk | null;
	/** The ask has been carried out, or cannot be. */
	onAsked: () => void;
}

export interface SourcePanelProps {
	client?: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
	/**
	 * The storage panel — what the showing source is syncing with — under the
	 * sources. A wide window keeps it at the foot of the sidebar; a compact one
	 * has no sidebar in view, and this is the panel that is about sources.
	 */
	account?: (slot: AccountSlot) => ReactNode;
	/** A source was chosen, so the panel has done its job. */
	onChosen?: () => void;
	/** How many times the app's URL has asked for the code field (`useEnterCode`). */
	enterCode?: number;
}

/**
 * The tabs and the `+`, as one panel, for a compact window: opened from the
 * source dropdown in `CompactBar` and laid out as the notebook and note panels
 * are, across the window under the bar.
 *
 * Its header is the notebooks' header (`Sidebar`): a `+` for another source,
 * which opens the same list of providers the `+` beside the tabs does, there
 * even with nothing to offer, disabled, so the header keeps its shape. Each
 * source's row ends in a `⋯` for what can be done to it, as each notebook's
 * and note's does: the showing source's is the storage panel's own; another's
 * shows that source and then does what was chosen (`SourceAsk`).
 *
 * The same choices in the same order, with the one showing marked by
 * `aria-current` as its tab is. A source is renamed from its `⋯`, its row
 * becoming the field as a notebook's does: on a tab it is a second press on
 * the name, but a row in a panel is a place to go, and pressing it again would
 * be how to shut the panel.
 */
export const SourcePanel = ({
	client = api,
	returnTo,
	navigate,
	account,
	onChosen,
	enterCode,
}: SourcePanelProps) => {
	const db = useDb();
	// Where a name being typed is told, for the bar's dropdown above.
	const renamings = useRenamings();
	const choices = useSourceChoices(client);
	const { ordered } = choices;
	// State rather than a ref: the storage panel draws its menu into this, and
	// has to be drawn again once it is there.
	const [actions, setActions] = useState<HTMLDivElement | null>(null);
	const [asked, setAsked] = useState<SourceAsk | null>(null);
	const onAsked = useCallback(() => {
		setAsked(null);
	}, []);
	const ids = ordered.map((source) => source.connectionId);
	// Which sources hold anything, so another's `⋯` offers a download only
	// where there is something to download, as the showing one's does.
	const holding = useLiveQuery(async () => {
		const holds = await Promise.all(ids.map((id) => holdsAnything(db, id)));
		return new Set(ids.filter((_, index) => holds[index] === true));
	}, [db, ids.join(' ')]);
	// What each source's key file for secrets was last read as, which says
	// whether its `⋯` offers to set them up or to open them.
	const keyFiles = useLiveQuery(
		async () => new Map((await db.keyFiles.toArray()).map((read) => [read.connectionId, read])),
		[db]
	);
	const showing = ordered.find((source) => source.active);
	const showingId = showing?.connectionId;
	// An ask still waiting is let go once another source is shown: it was for
	// the one the user went to, not for whenever that one is next shown. Here
	// as the render sees the change, as React has state follow a prop.
	const [shownWas, setShownWas] = useState(showingId);
	if (shownWas !== showingId) {
		setShownWas(showingId);
		if (asked !== null && asked.connectionId !== showingId) setAsked(null);
	}
	/** The source whose name is being typed, if one is. */
	const [renaming, setRenaming] = useState<string | null>(null);

	// A name given is shown until the store calls the source something other
	// than it did (`shownSourceName`), and let go of then.
	useEffect(() => {
		const settle = () => {
			const named = renamings?.get();
			if (named?.kind !== 'source' || named.given === undefined) return;
			const source = ordered.find((each) => each.connectionId === named.key);
			if (source === undefined || tabName(source, ordered) !== named.given.was)
				renamings?.clear('source', named.key);
		};
		settle();
		return renamings?.subscribe(settle);
	}, [renamings, ordered]);

	const renamed = (connectionId: string, was: string, chosen?: string) => {
		setRenaming(null);
		storeSourceName(db, connectionId, was, chosen, renamings);
	};
	/** Every source but this device's has a name of the user's to give it. */
	const renameItem = (source: ConnectedSource): OptionsMenuItem[] =>
		source.connectionId === LOCAL_CONNECTION_ID
			? []
			: [
					{
						label: t('sources.options.rename'),
						onChoose: () => {
							setRenaming(source.connectionId);
						},
					},
				];

	/** Another source's `⋯`: what its panel would offer once it is showing. */
	const itemsFor = (source: ConnectedSource): OptionsMenuItem[] => {
		if (!isLiveSource(source)) return renameItem(source);
		const show = (action?: SourceAsk['action']) => () => {
			setAsked(action === undefined ? null : { connectionId: source.connectionId, action });
			void showConnection(db, source.connectionId);
		};
		const download =
			holding?.has(source.connectionId) === true
				? [{ label: t('sources.options.download'), onChoose: show('download') }]
				: [];
		const syncable = source.provider !== undefined && CONNECTABLE.includes(source.provider);
		if (source.connectionId === LOCAL_CONNECTION_ID) return download;
		return [
			...renameItem(source),
			...(syncable
				? [
						{ label: t('sources.options.sync'), onChoose: show() },
						{ label: t('sources.options.rescan'), onChoose: show('rescan') },
						{
							label: secretsLabel(keyFiles?.get(source.connectionId)),
							onChoose: show('secrets'),
						},
					]
				: []),
			...download,
			{ label: t('sources.options.disconnect'), onChoose: show('disconnect'), danger: true },
		];
	};

	return (
		<section className="source-panel" aria-label={t('sources.title')}>
			<div className="pane-header">
				<h2>{t('sources.title')}</h2>
				<div className="pane-actions">
					<AddSource
						choices={choices}
						enterCode={enterCode}
						client={client}
						returnTo={returnTo}
						navigate={navigate}
						button={({ adding, toggle, offering, label }) => (
							<button
								type="button"
								className="icon"
								title={label}
								aria-label={label}
								aria-haspopup="true"
								aria-expanded={adding}
								disabled={!offering}
								onClick={toggle}
							>
								+
							</button>
						)}
					/>
				</div>
			</div>
			{ordered.length > 0 && (
				<ul>
					{ordered.map((source) => {
						const name = tabName(source, ordered);
						if (renaming === source.connectionId) {
							return (
								<li key={source.connectionId} className="row-item">
									<RowRename
										name={name}
										selected={source.active}
										maxLength={LABEL_LIMIT}
										mark={<ProviderIcon kind={sourceKind(source)} />}
										onDraft={(text) => {
											renamings?.typed('source', source.connectionId, text);
										}}
										onDone={(chosen) => {
											renamed(source.connectionId, name, chosen);
										}}
									/>
								</li>
							);
						}
						return (
							<li key={source.connectionId} className="row-item">
								<button
									type="button"
									className={source.active ? 'row selected' : 'row'}
									aria-label={sourceLabel(source, name)}
									{...(source.active ? { 'aria-current': 'true' as const } : {})}
									onClick={() => {
										onChosen?.();
										if (!source.active)
											void showConnection(db, source.connectionId);
									}}
								>
									<span className="row-marked">
										<ProviderIcon kind={sourceKind(source)} />
										<span className="row-label">
											<ShownSourceName source={source} name={name} />
										</span>
									</span>
								</button>
								{source.active ? (
									<div className="row-options" ref={setActions} />
								) : (
									<RowOptions
										name={name}
										kind="Source"
										items={itemsFor(source)}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<div className="source-panel-foot">
				{account?.({
					...(showing === undefined || showing.connectionId === LOCAL_CONNECTION_ID
						? {}
						: {
								onRename: () => {
									setRenaming(showing.connectionId);
								},
							}),
					menuIn: actions,
					name: showing === undefined ? '' : tabName(showing, ordered),
					asked,
					onAsked,
				})}
			</div>
		</section>
	);
};
