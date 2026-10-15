import { useState } from 'react';

import { t } from '../i18n/t.js';
import { type Age, loadAge } from '../secrets/loadAge.js';
import type { SecretsLock } from '../secrets/lock.js';
import type { NotesDatabase } from '../store/db.js';
import { replaceKeys } from '../store/secretKeys.js';
import { PasteKey } from './PasteKey.js';
import { SecretsModal } from './UnlockDialog.js';

export interface AddKeyDialogProps {
	database: NotesDatabase;
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
 */
export const AddKeyDialog = ({
	database,
	connectionId,
	armor,
	lock,
	age = loadAge,
	onAdded,
	onCancel,
}: AddKeyDialogProps) => {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const opens = async (identity: Uint8Array): Promise<string | undefined> => {
		const { opensSecret } = await age();
		return opensSecret(armor, [identity]) ? undefined : t('secrets.addKey.notIt');
	};

	const add = async (identity: Uint8Array) => {
		setBusy(true);
		setError(undefined);
		try {
			// Read now, and handed on with nothing awaited between: `replaceKeys`
			// copies them before its own, and the lock wipes its own as the page hides.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				onCancel();
				return;
			}
			const replaced = await replaceKeys(database, keys, keys.recipient, [
				...keys.identities,
				identity,
			]);
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
		<SecretsModal title={t('secrets.addKey.title')} onClose={onCancel}>
			<PasteKey
				text={t('secrets.addKey.text')}
				check={opens}
				busy={busy}
				onKey={(identity) => {
					void add(identity);
				}}
			/>
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
		</SecretsModal>
	);
};
