import { t } from '../i18n/t.js';
import type { KeyFileRecord } from '../store/db.js';
import type { Enrolment } from '../store/secretKeys.js';

/**
 * Whether a new secret can be sealed in a source on this device
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"): what an editor's Insert
 * secret asks, and the fill window's Save and Update. Apart from the editor's
 * secrets host (`noteSecrets.tsx`), which the fill window does not load.
 */

/**
 * Why a secret cannot be made or opened here; and whether the source's Secrets
 * dialog is the way on, to set the source up or to put the device right.
 */
export interface Why {
	readonly message: string;
	readonly way?: 'setUp' | 'open';
}

export const notEnrolled = (): Why => ({ message: t('editor.secret.notEnrolled'), way: 'open' });

/**
 * Why a new secret cannot be made in a source, for its key file as last read
 * and this device's keys; none where it can. The recipient sealed to is the
 * one the device enrolled with, so a key file that names another means the
 * key was replaced on another device.
 */
export const notHere = (
	file: KeyFileRecord | undefined,
	enrolled: Enrolment | undefined
): Why | undefined => {
	if (file?.state === 'newer') return { message: t('secrets.newer') };
	if (file?.state === 'invalid') return { message: t('secrets.invalid') };
	if (enrolled === undefined) {
		return file?.state === 'ok'
			? notEnrolled()
			: { message: t('editor.secret.notSetUp'), way: 'setUp' };
	}
	if (file?.state !== 'ok') return { message: t('editor.secret.lost'), way: 'open' };
	return enrolled.recipient === file.recipient
		? undefined
		: { message: t('editor.secret.replaced'), way: 'open' };
};
