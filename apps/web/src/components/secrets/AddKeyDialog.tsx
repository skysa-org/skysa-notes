import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';

import { t } from '../../i18n/t.js';
import { type Age, loadAge } from '../../secrets/loadAge.js';
import type { SecretsLock } from '../../secrets/lock.js';
import { useDb } from '../../store/database.js';
import { enrolment, replaceKeys } from '../../store/secretKeys.js';
import { Dialog } from '../ui/Dialog.js';
import { PasteKey } from './PasteKey.js';

export interface AddKeyDialogProps {
	connectionId: string;
	/** The secret the key has to open. */
	armor: string;
	lock: SecretsLock;
	age?: () => Promise<Age>;
	/** Kept: the device holds it now, beside the keys it had. */
	onAdded: () => void;
	/** Not kept, however that came about: asked away, or the device locked meanwhile. */
	onCancel: () => void;
}

/**
 * "Add its key" (docs/ARCHITECTURE.md §7, "Notes from another source"): the
 * key a secret was made with, typed and checked against that secret, then
 * sealed with the keys this device holds for the source, under the unlock it
 * has. It belongs to this device; other devices ask for it as they meet
 * such a secret.
 *
 * Where the folder names a key the device does not hold, the source's key was
 * replaced on another device (§7, "Replacing the key"), and a secret made
 * with it is one this device cannot open. That key, typed here, is kept as
 * the source's, first, with the keys the device held beside it, as the
 * Vault dialog keeps it.
 */
export const AddKeyDialog = ({
	connectionId,
	armor,
	lock,
	age = loadAge,
	onAdded,
	onCancel,
}: AddKeyDialogProps) => {
	const database = useDb();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const replacedElsewhere = useLiveQuery(async () => {
		const [file, enrolled] = await Promise.all([
			database.keyFiles.get(connectionId),
			enrolment(database, connectionId),
		]);
		return (
			file?.state === 'ok' && enrolled !== undefined && file.recipient !== enrolled.recipient
		);
	}, [database, connectionId]);

	const opens = async (identity: Uint8Array): Promise<string | undefined> => {
		const { opensSecret } = await age();
		return opensSecret(armor, [identity]) ? undefined : t('secrets.addKey.notIt');
	};

	const add = async (identity: Uint8Array) => {
		setBusy(true);
		setError(undefined);
		try {
			const { recipientOf } = await age();
			const file = await database.keyFiles.get(connectionId);
			// Read now, and handed on with nothing awaited between: `replaceKeys`
			// copies them before its own, and the lock wipes its own as the page hides.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				onCancel();
				return;
			}
			const named = file?.state === 'ok' ? file.recipient : undefined;
			// The key the folder names, which the device does not hold, or the
			// typed key would not have been needed: the source's, replaced.
			const replaced = await (named === recipientOf(identity)
				? replaceKeys(database, keys, named, [identity, ...keys.identities])
				: replaceKeys(database, keys, keys.recipient, [...keys.identities, identity]));
			if (replaced === undefined) {
				lock.lock(connectionId);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			lock.hold(replaced);
			onAdded();
		} catch {
			setError(t('secrets.failed'));
		} finally {
			identity.fill(0);
			setBusy(false);
		}
	};

	return (
		<Dialog title={t('secrets.addKey.title')} className="secrets-dialog" onClose={onCancel}>
			{/* Above the key, as the Vault dialog says its own: under it are the buttons. */}
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			<PasteKey
				text={
					replacedElsewhere === true
						? t('secrets.addKey.replaced')
						: t('secrets.addKey.text')
				}
				check={opens}
				busy={busy}
				onKey={(identity) => {
					void add(identity);
				}}
			/>
		</Dialog>
	);
};
