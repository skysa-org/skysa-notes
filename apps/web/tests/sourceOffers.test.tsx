import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
	type Offer,
	offersDisconnect,
	offersDownload,
	offersRescan,
	offersSecrets,
} from '../src/components/account/storageItems.js';
import { useAsked } from '../src/components/account/useAsked.js';
import type { AccountSlot, SourceAsk } from '../src/components/sources/SourcePanel.js';
import type { SyncStateRecord } from '../src/store/db.js';

/**
 * What a source's panel offers, which its gear shows and an ask from another
 * source's `⋯` is carried out by (#455): the one rule for both.
 */

const dropbox: SyncStateRecord = { connectionId: 'c1', clientId: 'client', provider: 'dropbox' };
const importing: SyncStateRecord = {
	...dropbox,
	importing: { lock: true, returnTo: 'local' },
};
const nowhere: SyncStateRecord = { connectionId: 'c2', clientId: 'client' };

describe('what a source’s panel offers', () => {
	it.each<[string, Offer, Offer]>([
		['a download of a source that holds notes', offersDownload(true, true), 'yes'],
		['a download of one that holds none', offersDownload(true, false), 'no'],
		['a download before the notes are counted', offersDownload(true, undefined), 'not yet'],
		['a download while it cannot be downloaded', offersDownload(false, true), 'no'],
		['a re-scan once it syncs', offersRescan(dropbox, 'idle'), 'yes'],
		['a re-scan before the scheduler syncs it', offersRescan(dropbox, 'local'), 'not yet'],
		['a re-scan during its first import', offersRescan(importing, 'syncing'), 'no'],
		['a re-scan of one that syncs nowhere', offersRescan(nowhere, 'idle'), 'no'],
		['secrets once it syncs', offersSecrets(dropbox, 'syncing'), 'yes'],
		['secrets before the scheduler syncs it', offersSecrets(dropbox, 'local'), 'not yet'],
		['secrets during its first import', offersSecrets(importing, 'syncing'), 'no'],
		['a disconnect', offersDisconnect(false, false), 'yes'],
		['a disconnect while one is still out', offersDisconnect(false, true), 'not yet'],
		['a disconnect while its question is open', offersDisconnect(true, false), 'no'],
	])('%s', (_, offer, expected) => {
		expect(offer).toBe(expected);
	});
});

const Asked = ({
	slot,
	offer,
	act: onAct,
}: {
	slot: AccountSlot;
	offer: Offer;
	act: (action: SourceAsk['action']) => void;
}) => {
	useAsked(slot, 'c1', () => offer, onAct);
	return null;
};

const slotAsking = (action: SourceAsk['action'], onAsked: () => void): AccountSlot => ({
	menuIn: null,
	name: 'Dropbox',
	asked: { connectionId: 'c1', action },
	onAsked,
});

describe('an ask from another source’s `⋯`', () => {
	it('is done once, when what it waits on arrives, and let go', () => {
		const onAct = vi.fn();
		const onAsked = vi.fn();
		const slot = slotAsking('rescan', onAsked);
		const { rerender } = render(<Asked slot={slot} offer="not yet" act={onAct} />);
		rerender(<Asked slot={slot} offer="not yet" act={onAct} />);
		expect(onAct).not.toHaveBeenCalled();
		expect(onAsked).not.toHaveBeenCalled();

		act(() => {
			rerender(<Asked slot={slot} offer="yes" act={onAct} />);
		});
		rerender(<Asked slot={slot} offer="yes" act={onAct} />);

		expect(onAct.mock.calls).toEqual([['rescan']]);
		expect(onAsked).toHaveBeenCalledOnce();
	});

	it('is let go without being done where the panel does not offer it', () => {
		const onAct = vi.fn();
		const onAsked = vi.fn();
		render(<Asked slot={slotAsking('download', onAsked)} offer="no" act={onAct} />);

		expect(onAct).not.toHaveBeenCalled();
		expect(onAsked).toHaveBeenCalledOnce();
	});

	it('is not this source’s to do when another was asked', () => {
		const onAct = vi.fn();
		const onAsked = vi.fn();
		const slot = {
			...slotAsking('rescan', onAsked),
			asked: { connectionId: 'c2', action: 'rescan' as const },
		};
		render(<Asked slot={slot} offer="yes" act={onAct} />);

		expect(onAct).not.toHaveBeenCalled();
		expect(onAsked).not.toHaveBeenCalled();
	});
});
