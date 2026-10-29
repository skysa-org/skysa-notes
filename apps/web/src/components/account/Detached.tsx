import { answer } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import type { SyncStateRecord } from '../../store/db.js';
import type { Unsynced } from '../../store/unsynced.js';
import { CONNECTABLE } from '../../sync/account.js';
import type { LocalProps } from './clients.js';
import { ConnectButton } from './ConnectButton.js';
import { DetachedSource } from './DetachedSource.js';
import { ActionsMenu } from './PanelMenus.js';

interface DetachedProps extends LocalProps {
	bound: SyncStateRecord;
	download: (listed: Unsynced) => Promise<void>;
	onReleased: () => void;
	/**
	 * What came of the disconnect that left it detached, where that is not what
	 * was asked for — the panel underneath the answer changes as the answer
	 * lands, so the source's own panel is where it has to be said.
	 */
	notice: string | null;
}

/**
 * The panel of a detached source (`DetachedSource`), given the two things only
 * this module can make for it: the way to connect its account again, and the
 * list of the other sources.
 *
 * Reconnecting is the ordinary connect flow, for the provider this source was
 * at, and offered only where the server offers that. Whether what comes back is
 * this source's account is decided when it is bound (`bindConnection`): the
 * same one takes these rows up, and any other is simply another source, with
 * these left exactly where they are.
 */
export const Detached = ({
	client,
	database,
	config,
	bound,
	download,
	onReleased,
	notice,
	returnTo,
	navigate,
	slot,
}: DetachedProps) => {
	const settings = answer(config);
	const provider = bound.provider;
	const reconnectable =
		provider !== undefined &&
		CONNECTABLE.includes(provider) &&
		settings?.authMode === 'storage-first' &&
		settings.providers.includes(provider);
	return (
		<>
			{/*
			 * Its own choices are what to do with what it holds, each a question
			 * with its answers beside it, and they stay in the panel; the menu is
			 * there, empty, so its row has the shape the others have.
			 */}
			{slot !== undefined && <ActionsMenu slot={slot} items={[]} />}
			<DetachedSource
				database={database}
				bound={bound}
				download={download}
				onReleased={onReleased}
				notice={notice}
				reconnect={
					reconnectable && (
						<ConnectButton
							db={database}
							client={client}
							provider={provider}
							returnTo={returnTo}
							{...(navigate === undefined ? {} : { navigate })}
						>
							{t('account.reconnect.detached')}
						</ConnectButton>
					)
				}
			/>
		</>
	);
};
