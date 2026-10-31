import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient, Grant } from '../../api/client.js';
import { answer, type Asked } from '../../api/instanceConfig.js';
import { failedAt, saying } from '../../errors/reached.js';
import { t } from '../../i18n/t.js';
import { credentialFor } from '../../store/credentials.js';
import { useDb } from '../../store/database.js';
import type { NotesDatabase } from '../../store/db.js';
import { Icon } from '../ui/icons.js';
import { InfoDialog } from '../ui/InfoDialog.js';
import type { Client } from './clients.js';
import { when } from './statusWords.js';

/**
 * The devices holding a source's connection, as the server lists them. The
 * device list shows them; the disconnect question counts them, since what it
 * does depends on whether this is the last.
 */
export const useGrants = (client: Client, connectionId: string) => {
	const database = useDb();
	const [grants, setGrants] = useState<Asked<Grant[]>>({ kind: 'asking' });

	// Only the newest question's answer is kept, and none once the source has
	// changed or the panel has gone. A slow answer about one source landing under
	// another's name is a list of grant ids the source on screen has never heard
	// of, each with a Remove button.
	const question = useRef(0);
	const ask = useCallback(() => {
		question.current += 1;
		const mine = question.current;
		const settle = (next: Asked<Grant[]>) => {
			if (question.current === mine) setGrants(next);
		};
		void withHeld(database, client, connectionId)
			.then((authed) => (authed === undefined ? undefined : authed.grants()))
			.then((result) => {
				settle(
					result === undefined || !result.ok
						? { kind: 'unreachable' }
						: { kind: 'answered', value: result.value }
				);
			})
			.catch(() => {
				settle({ kind: 'unreachable' });
			});
	}, [client, database, connectionId]);
	useEffect(() => {
		ask();
		return () => {
			question.current += 1;
		};
	}, [ask]);

	return { grants, ask };
};

/**
 * How many other devices a disconnect here would leave connected, or
 * `undefined` where the server has not said. One signed out for being idle is
 * not counted: the server does not count it either, and disconnecting the last
 * live device takes the account with it (`signOut`).
 */
export const stillSignedIn = (grants: Asked<Grant[]>): number | undefined =>
	answer(grants)?.filter((grant) => !grant.current && !grant.expired).length;

const devicesLine = (count: number): string => t('account.devices.count', { count });

/** Taking a device off the connection, and what went wrong if it did not come off. */
const useRevoke = (client: Client, connectionId: string, onChanged: () => void) => {
	const database = useDb();
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const revoke = (grantId: string) => {
		setBusy(grantId);
		setProblem(null);
		// Each half labelled as it is called: the credential is read from this
		// device and the grant is revoked on the server, and a failure of the
		// first has nothing to do with a connection. The device half runs strictly
		// before the server is asked, which is what lets its wording say that
		// nothing was removed.
		void failedAt('device', () => withHeld(database, client, connectionId))
			.then((authed) =>
				authed === undefined
					? undefined
					: failedAt('server', () => authed.revokeGrant(grantId))
			)
			.then((result) => {
				if (result?.ok === true) {
					onChanged();
					return;
				}
				setProblem(t('account.devices.stillSignedIn'));
			})
			.catch((error: unknown) => {
				setProblem(
					saying(error, {
						answered: t('account.devices.failed.answered'),
						unreachable: t('account.devices.failed.unreachable'),
						device: t('account.devices.failed.device'),
						// Neither call, so it happened after the revoke had already
						// done whatever it did.
						unknown: t('account.devices.failed.unknown'),
					})
				);
			})
			.finally(() => {
				setBusy(null);
			});
	};
	return { busy, problem, revoke };
};

/**
 * What a device's row says of it: what its browser called it, where it called
 * it anything, when it was last used, and whether the server has signed it out
 * for being idle.
 */
const deviceRow = ({ device, lastUsedAt, expired }: Grant): string => {
	const used = when(lastUsedAt);
	if (device === undefined) {
		return expired
			? t('account.devices.unnamedIdle', { when: used })
			: t('account.devices.unnamed', { when: used });
	}
	return expired
		? t('account.devices.namedIdle', { device, when: used })
		: t('account.devices.named', { device, when: used });
};

/** A row per other device, each with its Remove, and what went wrong with one. */
const DeviceRows = ({
	others,
	revoking,
}: {
	others: readonly Grant[];
	revoking: ReturnType<typeof useRevoke>;
}) => (
	<>
		<ul aria-label={t('account.devices.list')}>
			{others.map((grant) => (
				<li key={grant.id}>
					<span className="muted">{deviceRow(grant)}</span>
					<button
						type="button"
						disabled={revoking.busy !== null}
						onClick={() => {
							revoking.revoke(grant.id);
						}}
					>
						{t('account.devices.remove')}
					</button>
				</li>
			))}
		</ul>
		{revoking.problem !== null && (
			<p className="muted" role="alert">
				{revoking.problem}
			</p>
		)}
	</>
);

/**
 * The devices holding this connection, and the way to take one away.
 *
 * The point of it is that a stolen credential is visible and revocable. It is
 * the compensating control for holding a bearer in IndexedDB, where `httpOnly`
 * cannot protect it (docs/ARCHITECTURE.md §6), so it is asked for on open, and
 * how many other devices there are is said whether or not the list is open:
 * one more than the user has is what a theft looks like from here. The count
 * is in the status line (`StatusLine`), where there is room for it and not for
 * the rows: it is a button, beside the gear or the source's `⋯`, that opens
 * them over everything. Each row names the device as its browser did at
 * sign-in ("Safari on iPhone"), since a row that says only "a device" cannot
 * be told from the one in the user's pocket. This one is not among them.
 *
 * Revoking is permanent in a way worth saying: the server spends a credential's
 * hash for ever, so the device that held it cannot be talked back into this
 * connection — it has to be connected again from scratch.
 */
export const Devices = ({
	client,
	connectionId,
	grants,
	onChanged,
	gear,
}: {
	client: Client;
	/**
	 * Which source these are the devices of. Named rather than looked up: it
	 * pins every call in this component to one source, rather than re-reading
	 * "whichever is in front" between asking and revoking.
	 */
	connectionId: string;
	/**
	 * Asked by the panel (`useGrants`), keyed by the same source, which is what
	 * keeps the list from staying on the previous source's devices after a
	 * switch, with a Remove sending a grant id the new connection has never
	 * heard of. The panel's because the disconnect question counts them too.
	 */
	grants: Asked<Grant[]>;
	/** A device was removed: ask again. */
	onChanged: () => void;
	/**
	 * Where the focus goes when the list is put away with nobody left on it: the
	 * count it was opened from went with the last of them. The gear, or the
	 * source's `⋯`.
	 */
	gear?: RefObject<HTMLButtonElement | null>;
}) => {
	const revoking = useRevoke(client, connectionId, onChanged);
	const [open, setOpen] = useState(false);
	const count = useRef<HTMLButtonElement>(null);

	// This one is not listed: it cannot be removed from itself (disconnecting
	// is that), and "this device" is the one thing about it the user knows.
	const others = (answer(grants) ?? []).filter((grant) => !grant.current);
	// Kept open after the last other device is removed, saying so, rather than
	// taken away from under the focus.
	if (others.length === 0 && !open) return null;

	return (
		<>
			{others.length > 0 && (
				<button
					ref={count}
					type="button"
					className="icon icon-quiet account-devices-count"
					aria-label={devicesLine(others.length)}
					title={devicesLine(others.length)}
					onClick={() => {
						setOpen(true);
					}}
				>
					<Icon name="device" />
					<span aria-hidden="true">{others.length}</span>
				</button>
			)}
			{open && (
				<InfoDialog
					title={t('account.devices.title')}
					onClose={() => {
						setOpen(false);
						if (others.length === 0) gear?.current?.focus();
					}}
					returnFocus={count}
				>
					<div className="account-devices">
						{others.length === 0 ? (
							<p>{t('account.devices.none')}</p>
						) : (
							<DeviceRows others={others} revoking={revoking} />
						)}
					</div>
				</InfoDialog>
			)}
		</>
	);
};

/** The client, presenting the credential this device holds for one source. */
const withHeld = async (
	database: NotesDatabase,
	client: Client,
	connectionId: string
): Promise<ApiClient | undefined> => {
	const held = await credentialFor(database, connectionId);
	return held === undefined ? undefined : client.withCredential(held.credential);
};
